"use client";

import { useParams } from "next/navigation";
import { DetailPage } from "@/components/detail-view";

export default function SeriesPage() {
  const { key } = useParams<{ key: string }>();
  return <DetailPage kind="series" param={key} />;
}
