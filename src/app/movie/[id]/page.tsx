import type { Metadata } from "next";
import { DetailPage } from "@/components/detail-view";
import { movieMeta } from "@/lib/detail-meta";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const m = movieMeta(id);
  const images = m.image ? [m.image] : [];
  return {
    title: m.title,
    description: m.description,
    openGraph: { title: m.title, description: m.description, images },
    twitter: { card: m.image ? "summary_large_image" : "summary", title: m.title, description: m.description, images },
  };
}

export default async function MoviePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DetailPage kind="movie" param={id} />;
}
