import { redirect } from "next/navigation";

export default function DashboardPage() {
  // The terminal remains in the repository but is intentionally unreachable
  // until founder authentication and access policies are implemented.
  redirect("/");
}
