#!/usr/bin/env bun
import { readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'

// Bundled `bun run`-able render script for the doc-render plugin: the agent runs
// `bun run <this> <main.typ> <out.pdf>`. Lives as a script (not a registered
// tool) so it costs zero always-on system-prompt context, and the agent
// dynamic-imports the Typst compiler from writable per-session scratch — installed
// on first use, never baked into the image. Its on-disk path is published to a
// /tmp hint at boot (see index.ts) so the skill can resolve it.
//
// TODO(doc-render): PDF via Typst only. docx/xlsx/pptx are tracked separately —
// each an npm renderer installed via the same dynamic `bun add` + dynamic-import
// pattern. Office *conversion* (md->docx, docx->pdf) needs a system binary
// (LibreOffice/Pandoc), not an npm package, so it is out of scope here. See
// typeclaw/typeclaw#761.

// Keep in sync with the `bun add` line in skills/typeclaw-render-pdf/SKILL.md.
// 0.7.0 embeds Typst 0.14.2; bumping is a deliberate, re-validated edit.
export const COMPILER_PACKAGE = '@myriaddreamin/typst-ts-node-compiler'
export const COMPILER_VERSION = '0.7.0'
export const COMPILER_RUNTIME_DIR = '/tmp/typeclaw-doc-render-runtime'

// NodeCompiler does not auto-discover system font dirs the way the Typst CLI
// does; without these, CJK glyphs render as .notdef tofu. Filtered by existence
// so a missing dir on a dev/host run is skipped, not fatal.
export const FONT_PATHS = ['/usr/share/fonts', '/usr/local/share/fonts', '/Library/Fonts', '/System/Library/Fonts']

export function missingCompilerGuidance(): string {
  return [
    `doc-render: ${COMPILER_PACKAGE} is not installed.`,
    '',
    'Install the PDF toolchain in this session’s writable scratch runtime, then',
    're-run the render from the document directory:',
    '',
    `  mkdir -p ${COMPILER_RUNTIME_DIR} && cd ${COMPILER_RUNTIME_DIR}`,
    `  bun add ${COMPILER_PACKAGE}@${COMPILER_VERSION}`,
    '',
    'Do NOT fall back to jsPDF, pdfkit, a canvas text dump, a headless-browser',
    'raw-text print, or Python ReportLab — those skip Markdown rendering and ship',
    'no CJK font. This Typst path is the only supported one.',
  ].join('\n')
}

// The per-tool sandbox falls back to a degraded `--tmpfs /proc` on a host with
// no usable user namespaces, where Bun's loader can't read /proc/self/{fd,maps}
// and aborts with ENOTDIR. Rare since the proc-bind retry fix (typeclaw 0.35.1),
// but still possible on exotic runtimes — and unfixable by switching libraries.
function isNotDirError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOTDIR'
  )
}

function notDirGuidance(): string {
  return [
    'doc-render: the renderer aborted with a Bun "NotDir" / ENOTDIR error.',
    '',
    'This is the sandbox /proc degraded mode, not your markup and not a missing',
    'font: on a host with no usable user namespaces the per-tool sandbox falls',
    "back to a tmpfs /proc where bun can't run packages. Retry once; if it",
    'persists, report it as a sandbox/environment issue. A different PDF library',
    'will not fix a /proc problem.',
  ].join('\n')
}

type NodeCompilerModule = {
  NodeCompiler: {
    create(options: { workspace: string; fontArgs?: { fontPaths: string[] }[] }): {
      pdf(options: { mainFilePath: string }): Uint8Array
    }
  }
}

async function isMuslLinux(): Promise<boolean> {
  try {
    if ((await readFile('/usr/bin/ldd', 'utf8')).includes('musl')) return true
  } catch {
    // Continue with the same process-report fallback used by the package loader.
  }
  const report = process.report?.getReport() as
    | { header?: { glibcVersionRuntime?: string }; sharedObjects?: string[] }
    | undefined
  if (report?.header?.glibcVersionRuntime) return false
  return report?.sharedObjects?.some((file) => file.includes('libc.musl-') || file.includes('ld-musl-')) ?? false
}

export async function requiredCompilerPlatformPackage(): Promise<string> {
  const prefix = `${COMPILER_PACKAGE}-`
  if (process.platform === 'darwin' && (process.arch === 'x64' || process.arch === 'arm64')) {
    return `${prefix}darwin-${process.arch}`
  }
  if (process.platform === 'win32' && (process.arch === 'x64' || process.arch === 'arm64')) {
    return `${prefix}win32-${process.arch}-msvc`
  }
  if (process.platform === 'android' && process.arch === 'arm64') return `${prefix}android-arm64`
  if (process.platform === 'android' && process.arch === 'arm') return `${prefix}android-arm-eabi`
  if (process.platform === 'linux') {
    const libc = (await isMuslLinux()) ? 'musl' : 'gnu'
    if (process.arch === 'x64' || process.arch === 'arm64') return `${prefix}linux-${process.arch}-${libc}`
    if (process.arch === 'arm' && libc === 'gnu') return `${prefix}linux-arm-gnueabihf`
  }
  throw new Error(
    `doc-render: ${COMPILER_PACKAGE}@${COMPILER_VERSION} has no published platform package for ${process.platform}/${process.arch}`,
  )
}

type ValidatedRuntimePackage = {
  entry: string
}

async function validateRuntimePackage(
  runtimeDir: string,
  packageName: string,
  version: string,
): Promise<ValidatedRuntimePackage> {
  const packageDir = join(runtimeDir, 'node_modules', ...packageName.split('/'))
  const manifestPath = join(packageDir, 'package.json')
  let manifest: { name?: unknown; version?: unknown }
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { name?: unknown; version?: unknown }
  } catch {
    throw new Error(`doc-render: ${packageName}@${version} is not installed in ${runtimeDir}`)
  }
  if (manifest.name !== packageName || manifest.version !== version) {
    throw new Error(
      `doc-render: expected ${packageName}@${version} in ${runtimeDir}, found ${String(manifest.name)}@${String(manifest.version)}`,
    )
  }

  const resolved = Bun.resolveSync(packageDir, packageDir)
  const [realRuntimeDir, realPackageDir, realEntry] = await Promise.all([
    realpath(runtimeDir),
    realpath(packageDir),
    realpath(resolved),
  ])
  for (const [candidate, label] of [
    [realPackageDir, 'package'],
    [realEntry, 'entry'],
  ] as const) {
    const fromRuntime = relative(realRuntimeDir, candidate)
    if (fromRuntime === '..' || fromRuntime.startsWith(`..${sep}`) || isAbsolute(fromRuntime)) {
      throw new Error(`doc-render: ${packageName} ${label} resolves outside the scratch runtime`)
    }
  }
  const fromPackage = relative(realPackageDir, realEntry)
  if (fromPackage === '..' || fromPackage.startsWith(`..${sep}`) || isAbsolute(fromPackage)) {
    throw new Error(`doc-render: ${packageName} entry resolves outside its runtime-local package directory`)
  }
  return { entry: realEntry }
}

// Resolve only from the pinned scratch runtime. A document may contain an
// attacker-controlled node_modules tree, so its cwd must never enter resolution.
export async function loadCompilerModule(runtimeDir: string = COMPILER_RUNTIME_DIR): Promise<NodeCompilerModule> {
  const platformPackage = await requiredCompilerPlatformPackage()
  const compiler = await validateRuntimePackage(runtimeDir, COMPILER_PACKAGE, COMPILER_VERSION)
  await validateRuntimePackage(runtimeDir, platformPackage, COMPILER_VERSION)
  return (await import(compiler.entry)) as NodeCompilerModule
}

export async function renderPdf(mainFile: string, outFile: string): Promise<number> {
  const { existsSync } = await import('node:fs')

  const fontPaths = FONT_PATHS.filter((p) => existsSync(p))
  const mod = await loadCompilerModule()
  const compiler = mod.NodeCompiler.create({
    workspace: '.',
    ...(fontPaths.length > 0 ? { fontArgs: [{ fontPaths }] } : {}),
  })
  const pdf = compiler.pdf({ mainFilePath: mainFile })
  await Bun.write(outFile, pdf)
  return pdf.length
}

// Bun phrasings for an unresolved import. Broad on purpose: a false positive only
// shows the install hint on an unrelated error, and the package name in the
// message keeps it specific in practice.
export function isModuleNotFound(message: string): boolean {
  return (
    message.includes('Cannot find package') ||
    message.includes('Cannot find module') ||
    message.includes('Module not found') ||
    message.includes(COMPILER_PACKAGE)
  )
}

const EXIT_RENDER_FAILED = 1
const EXIT_BAD_USAGE = 2
const EXIT_COMPILER_MISSING = 3

async function main(): Promise<void> {
  const [, , mainFile, outFile] = process.argv
  if (!mainFile || !outFile) {
    process.stderr.write('usage: bun run render.ts <main.typ> <out.pdf>\n')
    process.exit(EXIT_BAD_USAGE)
  }

  let bytes: number
  try {
    bytes = await renderPdf(mainFile, outFile)
  } catch (error) {
    if (isNotDirError(error)) {
      process.stderr.write(`${notDirGuidance()}\n`)
      process.exit(EXIT_RENDER_FAILED)
    }
    const message = error instanceof Error ? error.message : String(error)
    if (isModuleNotFound(message)) {
      process.stderr.write(`${missingCompilerGuidance()}\n`)
      process.exit(EXIT_COMPILER_MISSING)
    }
    process.stderr.write(`doc-render: render failed: ${message}\n`)
    process.exit(EXIT_RENDER_FAILED)
  }

  process.stdout.write(`wrote ${outFile} (${bytes} bytes)\n`)
}

if (import.meta.main) {
  await main()
}
