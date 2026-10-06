export function shouldBlockSessionCreation(createSessionPending: boolean, creationInFlight: boolean): boolean {
  return createSessionPending || creationInFlight
}
