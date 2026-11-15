/** Error codes shared across core and transport. Transport translates these to
 * protocol-specific shapes; the codes themselves are part of the contract. */
export const ErrorCode = {
  E_HUB_NOT_INITIALIZED: 'E_HUB_NOT_INITIALIZED',
  E_NOT_FOUND: 'E_NOT_FOUND',
  E_VALIDATION: 'E_VALIDATION',
  E_CONFLICT: 'E_CONFLICT',
  E_LOCK_HELD: 'E_LOCK_HELD',
  E_APPROVAL_REQUIRED: 'E_APPROVAL_REQUIRED',
  E_READONLY: 'E_READONLY',
} as const

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode]

export class HubError extends Error {
  readonly code: ErrorCodeValue
  readonly details?: Record<string, unknown>

  constructor(code: ErrorCodeValue, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'HubError'
    this.code = code
    this.details = details
  }
}
