/**
 * Bidirectional channel to a parent process (Electron GUI via utilityProcess.parentPort,
 * or a plain Node parent via process.send). Returns null when running standalone.
 */
export function parentChannel () {
  const port = process.parentPort
  if (port) {
    return {
      send: (msg) => { try { port.postMessage(msg) } catch {} },
      on: (fn) => port.on('message', (e) => fn(e.data))
    }
  }
  if (typeof process.send === 'function') {
    return {
      send: (msg) => { try { process.send(msg) } catch {} },
      on: (fn) => process.on('message', fn)
    }
  }
  return null
}
