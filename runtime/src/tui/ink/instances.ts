// Store all instances of Ink (instance.js) to ensure that consecutive render() calls
// use the same instance of Ink and don't create a new one
//
// This map has to be stored in a separate file, because render.js creates instances,
// but instance.js should delete itself from the map on unmount

import type Ink from './ink.js'

const instances = new Map<NodeJS.WriteStream, Ink>()

export function getInkInstance(stdout: NodeJS.WriteStream = process.stdout): Ink | undefined {
  return instances.get(stdout)
}

export function setInkInstance(stdout: NodeJS.WriteStream, instance: Ink): void {
  instances.set(stdout, instance)
}

export function deleteInkInstance(stdout: NodeJS.WriteStream): boolean {
  return instances.delete(stdout)
}

export default instances
