import { ClaudeIntegrationPane } from "../../components/settings/ClaudeIntegrationPane";
import { GithubPane } from "../../components/settings/GithubPane";
import { LinearPane } from "../../components/settings/LinearPane";

export function IntegrationsRoute() {
  return (
    <div className="space-y-8">
      <ClaudeIntegrationPane />
      <GithubPane />
      <LinearPane />
    </div>
  );
}
