// License 许可授权 API
import api from '../http'

export interface LicenseStatus {
  activated: boolean
  enforced: boolean
  showUI: boolean
  licensee?: string
  edition?: string
  features?: string[]
  issuedAt?: string
  expiresAt?: string
  available?: boolean
}

export const licenseApi = {
  getStatus: (config?: { silent?: boolean }) =>
    api.get<{ data: LicenseStatus }>('/license/status', config),
  activate: (key: string) =>
    api.post<{ data: { licensee: string; edition: string; features: string[]; expiresAt: string } }>(
      '/license/activate', { key }),
  deactivate: () => api.delete('/license'),
}
