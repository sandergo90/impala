import { ClaudeIntegrationPane } from "../../components/settings/ClaudeIntegrationPane";
import { LinearPane } from "../../components/settings/LinearPane";

export function IntegrationsRoute() {
  return (
    <div className="space-y-8">
      <ClaudeIntegrationPane />
      <LinearPane />
    </div>
  );
}
