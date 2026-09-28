import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { createChart, CandlestickSeries } from "lightweight-charts";

const THEMES = {
  light: {
    textColor: "#3a3a3c",
    bg: "#ffffff",
    grid: "#e5e5ea",
    up: "#34c759",
    down: "#ff3b30",
  },
  dark: {
    textColor: "#d1d5db",
    bg: "#0b0f19",
    grid: "#1f2937",
    up: "#22c55e",
    down: "#ef4444",
  },
};

const Chart = forwardRef(function Chart({ data, theme = "dark" }, ref) {
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
    const c = THEMES[theme] || THEMES.dark;

    const chart = createChart(containerRef.current, {
      layout: {
        textColor: c.textColor,
        background: { type: "solid", color: c.bg },
      },
      grid: {
        vertLines: { color: c.grid },
        horzLines: { color: c.grid },
      },
      width: containerRef.current.clientWidth,
      height: 500,
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: c.up,
      downColor: c.down,
      borderVisible: false,
      wickUpColor: c.up,
      wickDownColor: c.down,
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
  }, [theme]);

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
