export function discardRejection(task: Promise<unknown> | (() => Promise<unknown> | unknown)) {
  const promise = typeof task === 'function' ? Promise.resolve().then(task) : task
  void promise.catch(() => undefined)
}
