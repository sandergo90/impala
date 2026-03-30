use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::sync::LazyLock;

const LINEAR_API_URL: &str = "https://api.linear.app/graphql";

static CLIENT: LazyLock<reqwest::blocking::Client> = LazyLock::new(reqwest::blocking::Client::new);

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LinearIssue {
    pub id: String,
    pub identifier: String,
    pub title: String,
    pub branch_name: String,
    pub status: String,
    pub url: String,
}

#[derive(Deserialize)]
struct GraphQLResponse<T> {
    data: Option<T>,
    errors: Option<Vec<GraphQLError>>,
}

#[derive(Deserialize)]
struct GraphQLError {
    message: String,
}

fn parse_response<T: DeserializeOwned>(raw: &str, context: &str) -> Result<T, String> {
    let parsed: GraphQLResponse<T> = serde_json::from_str(raw)
        .map_err(|e| format!("Failed to parse {}: {}", context, e))?;

    if let Some(errors) = parsed.errors {
        if !errors.is_empty() {
            return Err(format!("Linear API error: {}", errors[0].message));
        }
    }

    parsed.data.ok_or_else(|| format!("No data in {} response", context))
}

// --- Viewer's assigned issues (Todo + In Progress) ---

#[derive(Deserialize)]
struct MyIssuesData {
    viewer: Viewer,
}

#[derive(Deserialize)]
struct Viewer {
    #[serde(rename = "assignedIssues")]
    assigned_issues: IssueConnection,
}

#[derive(Deserialize)]
struct IssueConnection {
    nodes: Vec<IssueNode>,
}

#[derive(Deserialize)]
struct IssueNode {
    id: String,
    identifier: String,
    title: String,
    #[serde(rename = "branchName")]
    branch_name: String,
    url: String,
    state: IssueState,
}

#[derive(Deserialize)]
struct IssueState {
    name: String,
    #[serde(rename = "type")]
    state_type: String,
}

impl IssueNode {
    fn into_linear_issue(self) -> LinearIssue {
        LinearIssue {
            id: self.id,
            identifier: self.identifier,
            title: self.title,
            branch_name: self.branch_name,
            status: self.state.name,
            url: self.url,
        }
    }
}

pub fn get_my_issues(api_key: &str) -> Result<Vec<LinearIssue>, String> {
    let query = r#"{
        viewer {
            assignedIssues(
                filter: {
                    state: { type: { in: ["started", "unstarted"] } }
                }
                orderBy: updatedAt
                first: 50
            ) {
                nodes {
                    id
                    identifier
                    title
                    branchName
                    url
                    state { name type }
                }
            }
        }
    }"#;

    let response = make_request(api_key, query, &serde_json::json!({}))?;
    let data: MyIssuesData = parse_response(&response, "Linear issues")?;
    Ok(data.viewer.assigned_issues.nodes.into_iter().map(|n| n.into_linear_issue()).collect())
}

// --- Search issues ---

#[derive(Deserialize)]
struct SearchData {
    #[serde(rename = "searchIssues")]
    search_issues: IssueConnection,
}

pub fn search_issues(api_key: &str, query_text: &str) -> Result<Vec<LinearIssue>, String> {
    let query = r#"query($term: String!) {
        searchIssues(
            term: $term
            first: 20
        ) {
            nodes {
                id
                identifier
                title
                branchName
                url
                state { name type }
            }
        }
    }"#;

    let variables = serde_json::json!({ "term": query_text });
    let response = make_request(api_key, query, &variables)?;
    let data: SearchData = parse_response(&response, "Linear search")?;
    Ok(data.search_issues.nodes.into_iter().map(|n| n.into_linear_issue()).collect())
}

// --- Update issue state to "In Progress" ---

#[derive(Deserialize)]
struct WorkflowStateConnection {
    nodes: Vec<WorkflowStateNode>,
}

#[derive(Deserialize)]
#[allow(dead_code)]
struct WorkflowStateNode {
    id: String,
    name: String,
    #[serde(rename = "type")]
    state_type: String,
}

#[derive(Deserialize)]
struct IssueDetail {
    team: TeamRef,
    state: IssueState,
}

#[derive(Deserialize)]
struct TeamRef {
    id: String,
}

#[derive(Deserialize)]
struct UpdateIssueData {
    #[serde(rename = "issueUpdate")]
    issue_update: IssueUpdatePayload,
}

#[derive(Deserialize)]
struct IssueUpdatePayload {
    success: bool,
}

pub fn start_issue(api_key: &str, issue_id: &str) -> Result<(), String> {
    // Step 1: get issue's team and current state
    let issue_query = r#"query($issueId: String!) {
        issue(id: $issueId) {
            team { id }
            state { name type }
        }
    }"#;
    let issue_vars = serde_json::json!({ "issueId": issue_id });
    let issue_response = make_request(api_key, issue_query, &issue_vars)?;

    #[derive(Deserialize)]
    struct IssueOnlyData { issue: IssueDetail }
    let issue_data: IssueOnlyData = parse_response(&issue_response, "issue detail")?;

    // Already in progress — nothing to do
    if issue_data.issue.state.state_type == "started" {
        return Ok(());
    }

    // Step 2: get workflow states for this team and update in one call
    // (We can't combine steps 1 and 2 because the team filter depends on step 1)
    let states_query = r#"query($teamId: ID!) {
        workflowStates(
            filter: { team: { id: { eq: $teamId } }, type: { eq: "started" } }
            first: 10
        ) {
            nodes { id name type }
        }
    }"#;
    let states_vars = serde_json::json!({ "teamId": issue_data.issue.team.id });
    let states_response = make_request(api_key, states_query, &states_vars)?;

    #[derive(Deserialize)]
    struct StatesOnlyData {
        #[serde(rename = "workflowStates")]
        workflow_states: WorkflowStateConnection,
    }
    let states_data: StatesOnlyData = parse_response(&states_response, "workflow states")?;

    // Prefer the state named "In Progress"; fall back to first "started" state
    let states = &states_data.workflow_states.nodes;
    let in_progress_state = states.iter()
        .find(|s| s.name == "In Progress")
        .or_else(|| states.first())
        .ok_or_else(|| "No 'In Progress' state found for this team".to_string())?;

    // Update the issue's state
    let update_query = r#"mutation($issueId: String!, $stateId: String!) {
        issueUpdate(id: $issueId, input: { stateId: $stateId }) {
            success
        }
    }"#;
    let update_vars = serde_json::json!({
        "issueId": issue_id,
        "stateId": in_progress_state.id,
    });
    let update_response = make_request(api_key, update_query, &update_vars)?;
    let update_data: UpdateIssueData = parse_response(&update_response, "issue update")?;

    if !update_data.issue_update.success {
        return Err("Failed to update issue state".to_string());
    }

    Ok(())
}

// --- HTTP helper ---

fn make_request(api_key: &str, query: &str, variables: &serde_json::Value) -> Result<String, String> {
    let body = serde_json::json!({ "query": query, "variables": variables });

    let response = CLIENT
        .post(LINEAR_API_URL)
        .header("Authorization", api_key)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .map_err(|e| format!("Linear API request failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Linear API returned status {}", response.status()));
    }

    response.text().map_err(|e| format!("Failed to read Linear response: {}", e))
}
