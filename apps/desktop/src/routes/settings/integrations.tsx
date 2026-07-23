import { AgentIntegrationPane } from "../../components/settings/AgentIntegrationPane";
import { BitbucketPane } from "../../components/settings/BitbucketPane";
import { GithubPane } from "../../components/settings/GithubPane";
import { LinearPane } from "../../components/settings/LinearPane";

export function IntegrationsRoute() {
  return (
    <div className="space-y-8">
      <h2 className="text-base font-semibold text-foreground">Integrations</h2>
      <AgentIntegrationPane />
      <GithubPane />
      <BitbucketPane />
      <LinearPane />
    </div>
  );
}
