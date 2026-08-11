import type { Metadata } from "next";
import { ArcTanExperience } from "@/components/ArcTanExperience";

export const metadata: Metadata = {
  title: "arc(Tan)",
  description: "A peptide protocol companion by NB&E Technologies.",
};

export default function ArcTanPage() {
  return <ArcTanExperience />;
}
