import { useMemo } from "react";
import { barY, defineChart, lineY } from "@tanstack/charts";
import { scaleBand } from "@tanstack/charts/scales/band";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { scalePoint } from "@tanstack/charts/scales/point";
import { tooltip } from "@tanstack/charts/tooltip";
import { Chart } from "@tanstack/charts/react";
import type { ToneTrendPoint } from "../radar-types";

function dayLabel(day: string): string {
  // YYYYMMDD -> M/D
  if (day.length !== 8) return day;
  return `${Number(day.slice(4, 6))}/${Number(day.slice(6, 8))}`;
}

/** Daily counts (bars) and average tone (line), TanStack Charts. */
export function ToneChart({ trend }: { trend: ToneTrendPoint[] }) {
  const { countDef, toneDef } = useMemo(() => {
    const counts = trend.map((t) => ({
      day: dayLabel(t.day),
      count: t.count,
    }));
    const tones = trend
      .filter((t) => t.avgTone !== null)
      .map((t) => ({ day: dayLabel(t.day), tone: t.avgTone as number }));
    const countChart = defineChart({
      marks: [barY(counts, { x: "day", y: "count" })],
      scales: {
        x: { scale: () => scaleBand().padding(0.25) },
        y: { scale: scaleLinear, nice: true, grid: true },
      },
      tooltip,
    });
    const toneChart =
      tones.length > 0
        ? defineChart({
            marks: [lineY(tones, { x: "day", y: "tone" })],
            scales: {
              x: { scale: () => scalePoint() },
              y: { scale: scaleLinear, nice: true, grid: true },
            },
            tooltip,
          })
        : null;
    return { countDef: countChart, toneDef: toneChart };
  }, [trend]);

  if (trend.length === 0) {
    return <p className="empty">トーン推移のデータがありません。</p>;
  }
  return (
    <figure className="tone-charts">
      <div className="tone-chart">
        <figcaption>日別件数</figcaption>
        <Chart definition={countDef} height={132} ariaLabel="日別記事件数" />
      </div>
      {toneDef ? (
        <div className="tone-chart">
          <figcaption>平均トーン</figcaption>
          <Chart definition={toneDef} height={132} ariaLabel="日別平均トーン" />
        </div>
      ) : (
        <div className="tone-chart">
          <figcaption>平均トーン</figcaption>
          <p className="empty">トーン値のある日がありません。</p>
        </div>
      )}
    </figure>
  );
}
