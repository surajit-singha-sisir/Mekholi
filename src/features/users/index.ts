import type { Route } from '../../app/router/router'
import type { PluginRegistry } from '../../shared/registry/plugin-registry'
import { usersView } from './users-view'

export interface UserRoutesOptions {
  registry: PluginRegistry
}

export function userRoutes(options: UserRoutesOptions): Route[] {
  return [
    {
      path: '/users',
      title: 'Staff',
      permission: 'users.view',
      render: () => usersView({ registry: options.registry }),
    },
  ]
}

export { usersView }
