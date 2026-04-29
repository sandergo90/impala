import { AgentIntegrationPane } from "../../components/settings/AgentIntegrationPane";
import { GithubPane } from "../../components/settings/GithubPane";
import { LinearPane } from "../../components/settings/LinearPane";

export function IntegrationsRoute() {
  return (
    <div className="space-y-8">
      <AgentIntegrationPane />
      <GithubPane />
      <LinearPane />
    </div>
  );
}
