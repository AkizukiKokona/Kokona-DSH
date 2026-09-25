let quitting = false

export function isQuitting(): boolean {
  return quitting
}

export function setQuitting(value: boolean): void {
  quitting = value
}
