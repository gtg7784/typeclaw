#!/usr/bin/env bun

import { buildBaseDockerfile } from '../src/init/dockerfile'

process.stdout.write(buildBaseDockerfile())
