// Serialize credentials and connection changes for one socket. A slow save on
// "open" must finish before "close"; late callbacks cannot revive old sockets.
export function createSessionLifecycle(isCurrent) {
  let tail = Promise.resolve();
  return (task) => {
    const result = tail.catch(() => undefined).then(() => isCurrent() ? task() : undefined);
    tail = result;
    return result;
  };
}
