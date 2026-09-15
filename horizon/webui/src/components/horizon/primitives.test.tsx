import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"

import { MetricValue, MetricWithBaseline } from "./primitives"
import { SparkChart } from "./spark-chart"

/**
 * The rendering half of the missing-versus-zero rule: whatever the normalizer
 * decides, the screen has to show the difference.
 */

describe("MetricValue", () => {
  it("renders an observed zero as 0", () => {
    render(<MetricValue value={0} />)
    expect(screen.getByText("0")).toBeInTheDocument()
    expect(screen.queryByText("No data")).not.toBeInTheDocument()
  })

  it("renders a missing measurement as an accessible no-data marker, not 0", () => {
    render(<MetricValue value={null} />)
    expect(screen.queryByText("0")).not.toBeInTheDocument()
    expect(screen.getByText("No data")).toBeInTheDocument()
  })

  it("renders undefined the same way as null", () => {
    render(<MetricValue value={undefined} />)
    expect(screen.getByText("No data")).toBeInTheDocument()
  })

  it("keeps the unit on a real value", () => {
    render(<MetricValue value={4} unit="d" />)
    expect(screen.getByText(/4d/)).toBeInTheDocument()
  })
})

describe("MetricWithBaseline", () => {
  it("omits the delta when the current value is missing", () => {
    render(<MetricWithBaseline label="Activity" value={null} baseline={5} />)
    expect(screen.getByText("No data")).toBeInTheDocument()
    expect(screen.queryByText(/baseline/)).not.toBeInTheDocument()
  })

  it("omits the delta when there is no baseline to compare against", () => {
    render(<MetricWithBaseline label="Activity" value={5} baseline={null} />)
    expect(screen.queryByText(/baseline/)).not.toBeInTheDocument()
  })

  it("shows the direction when both sides were measured", () => {
    render(<MetricWithBaseline label="Activity" value={7} baseline={5} />)
    expect(screen.getByText(/▲ vs 5 baseline/)).toBeInTheDocument()
  })
})

describe("SparkChart", () => {
  it("refuses to draw a line for a series with no observations", () => {
    render(<SparkChart points={[null, null, null, null, null, null, null, null]} stroke="var(--status-clear)" />)
    expect(screen.getByText("Insufficient data")).toBeInTheDocument()
    expect(screen.queryByRole("img", { name: "8-week trend" })).not.toBeInTheDocument()
  })

  it("draws a chart once at least one week was measured", () => {
    render(<SparkChart points={[1, null, 3, null, null, null, null, null]} stroke="var(--status-clear)" />)
    expect(screen.getByRole("img", { name: "8-week trend" })).toBeInTheDocument()
    expect(screen.queryByText("Insufficient data")).not.toBeInTheDocument()
  })
})
