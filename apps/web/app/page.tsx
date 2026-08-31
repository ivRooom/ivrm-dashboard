import { getOverviewSnapshot } from "../lib/overview";
import { OverviewDashboard } from "./overview-dashboard";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const data = await getOverviewSnapshot();
  return <OverviewDashboard data={data} />;
}
