import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { createChart, CandlestickSeries } from "lightweight-charts";

const Chart = forwardRef(function Chart({ data }, ref) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);

  useImperativeHandle(ref, () => ({
    screenshot() {
      try {
        const canvas = chartRef.current?.takeScreenshot?.();
        return canvas ? canvas.toDataURL("image/png") : null;
      } catch {
        return null;
      }
    },
  }));

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        textColor: "#d1d5db",
        background: { type: "solid", color: "#0b0f19" },
      },
      grid: {
        vertLines: { color: "#1f2937" },
        horzLines: { color: "#1f2937" },
      },
      width: containerRef.current.clientWidth,
      height: 500,
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#22c55e",
      downColor: "#ef4444",
      borderVisible: false,
      wickUpColor: "#22c55e",
      wickDownColor: "#ef4444",
    });

    chartRef.current = chart;
    seriesRef.current = series;

    const resizeObserver = new ResizeObserver(() => {
      if (!containerRef.current) return;
      chart.applyOptions({ width: containerRef.current.clientWidth });
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      chart.remove();
    };
  }, []);

  useEffect(() => {
    if (!seriesRef.current || !data?.length) return;
    // Phase 1: setData full refresh. Phase 1.1 will switch to update() for last candle.
    seriesRef.current.setData(data);
    chartRef.current?.timeScale().fitContent();
  }, [data]);

  return (
    <div
      ref={containerRef}
      style={{ width: "100%", height: "500px" }}
    />
  );
});

export default Chart;
