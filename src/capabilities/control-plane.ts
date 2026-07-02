import { type Controller, type DeploymentProfile, resolveController, resolveDeploymentProfile } from '@/container'

// The host-stage capability bag: what the host process (CLI / hostd / a future
// managed control task) can DO to a container. Assembled once at the host-stage
// composition root and passed to the modules that need it — NOT a service
// locator (build at the root, hand specific capabilities down).
//
// Only `controller` today; restartSupervisor / portBroker / credentialRenewers
// slot in here as they are extracted (see the capability-composition design).
export type ControlPlaneCapabilities = {
  controller: Controller
}

// Composes the host-stage capabilities for a deployment profile. `host` uses
// local Docker; `managed` (no runtime yet) would use platform impls. The
// profile is resolved once here so the whole bag reflects one coherent
// environment decision.
export function createControlPlaneCapabilities(
  profile: DeploymentProfile = resolveDeploymentProfile(),
): ControlPlaneCapabilities {
  return {
    controller: resolveController(profile),
  }
}
