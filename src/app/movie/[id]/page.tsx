"use client";

import { useParams } from "next/navigation";
import { DetailPage } from "@/components/detail-view";

export default function MoviePage() {
  const { id } = useParams<{ id: string }>();
  return <DetailPage kind="movie" param={id} />;
}
