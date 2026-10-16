import { describe, expect, it, vi } from "vitest"
import type { EventPayload } from "../../index.js"

const native = vi.hoisted(() => ({ callback: undefined as undefined | ((error: unknown, event: EventPayload) => void) }))
vi.mock("@gpuix/native", () => ({
  GpuixRenderer: class {
    constructor(callback: (error: unknown, event: EventPayload) => void) { native.callback = callback }
    init() {}
    applyBatch() { return [] }
  },
}))
import { createNativeRenderer } from "../runtime.js"
import { createRendererState } from "../renderer-state.js"

describe("renderer close lifecycle", () => {
  it("delivers only native close requests before a root and preserves root delivery", () => {
    const events: EventPayload[] = []
    const rootEvents: EventPayload[] = []
    const renderer = createNativeRenderer({ onEvent: (event) => events.push(event) })
    const request = { elementId: 0, eventType: "closeRequested", closeRequestId: "7:1", windowGeneration: "7" }
    native.callback?.(null, request)
    expect(events).toEqual([request])
    native.callback?.(null, { elementId: 42, eventType: "change" })
    native.callback?.(null, { elementId: 42, eventType: "closeRequested" })
    expect(events).toHaveLength(1)
    const root = createRendererState(renderer).attach({ onEvent: (event) => rootEvents.push(event) })
    native.callback?.(null, request)
    expect(events).toEqual([request, request])
    expect(rootEvents).toEqual([request])
    root.detach()
  })
})
