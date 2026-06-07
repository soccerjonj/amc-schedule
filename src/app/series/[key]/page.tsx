import type { Metadata } from "next";
import { DetailPage } from "@/components/detail-view";
import { seriesMeta } from "@/lib/detail-meta";

export async function generateMetadata({ params }: { params: Promise<{ key: string }> }): Promise<Metadata> {
  const { key } = await params;
  const m = seriesMeta(key);
  const images = m.image ? [m.image] : [];
  return {
    title: m.title,
    description: m.description,
    openGraph: { title: m.title, description: m.description, images },
    twitter: { card: m.image ? "summary_large_image" : "summary", title: m.title, description: m.description, images },
  };
}

export default async function SeriesPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  return <DetailPage kind="series" param={key} />;
}
