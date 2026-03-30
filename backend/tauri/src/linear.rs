use serde::{Deserialize, Serialize};

const LINEAR_API_URL: &str = "https://api.linear.app/graphql";

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

    let response = make_request(api_key, query)?;
    let parsed: GraphQLResponse<MyIssuesData> = serde_json::from_str(&response)
        .map_err(|e| format!("Failed to parse Linear response: {}", e))?;

    if let Some(errors) = parsed.errors {
        if !errors.is_empty() {
            return Err(format!("Linear API error: {}", errors[0].message));
        }
    }

    let data = parsed.data.ok_or_else(|| "No data in Linear response".to_string())?;
    Ok(data.viewer.assigned_issues.nodes.into_iter().map(|n| n.into_linear_issue()).collect())
}

// --- Search issues ---

#[derive(Deserialize)]
struct SearchData {
    #[serde(rename = "issueSearch")]
    issue_search: IssueConnection,
}

pub fn search_issues(api_key: &str, query_text: &str) -> Result<Vec<LinearIssue>, String> {
    let query = format!(
        r#"{{
            issueSearch(
                query: "{}"
                first: 20
                includeArchived: false
            ) {{
                nodes {{
                    id
                    identifier
                    title
                    branchName
                    url
                    state {{ name type }}
                }}
            }}
        }}"#,
        query_text.replace('"', "\\\"")
    );

    let response = make_request(api_key, &query)?;
    let parsed: GraphQLResponse<SearchData> = serde_json::from_str(&response)
        .map_err(|e| format!("Failed to parse Linear response: {}", e))?;

    if let Some(errors) = parsed.errors {
        if !errors.is_empty() {
            return Err(format!("Linear API error: {}", errors[0].message));
        }
    }

    let data = parsed.data.ok_or_else(|| "No data in Linear response".to_string())?;
    Ok(data.issue_search.nodes.into_iter().map(|n| n.into_linear_issue()).collect())
}

// --- Update issue state to "In Progress" ---

#[derive(Deserialize)]
struct TeamStatesData {
    #[serde(rename = "workflowStates")]
    workflow_states: WorkflowStateConnection,
}

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
struct IssueDetailData {
    issue: IssueDetail,
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
    // First, get the issue's team and current state
    let detail_query = format!(
        r#"{{
            issue(id: "{}") {{
                team {{ id }}
                state {{ name type }}
            }}
        }}"#,
        issue_id
    );
    let detail_response = make_request(api_key, &detail_query)?;
    let detail: GraphQLResponse<IssueDetailData> = serde_json::from_str(&detail_response)
        .map_err(|e| format!("Failed to parse issue detail: {}", e))?;
    let detail_data = detail.data.ok_or_else(|| "No data for issue detail".to_string())?;

    // If already in "started" state, nothing to do
    if detail_data.issue.state.state_type == "started" {
        return Ok(());
    }

    // Find the "started" (In Progress) workflow state for this team
    let states_query = format!(
        r#"{{
            workflowStates(
                filter: {{
                    team: {{ id: {{ eq: "{}" }} }}
                    type: {{ eq: "started" }}
                }}
                first: 10
            ) {{
                nodes {{ id name type }}
            }}
        }}"#,
        detail_data.issue.team.id
    );
    let states_response = make_request(api_key, &states_query)?;
    let states: GraphQLResponse<TeamStatesData> = serde_json::from_str(&states_response)
        .map_err(|e| format!("Failed to parse workflow states: {}", e))?;
    let states_data = states.data.ok_or_else(|| "No workflow states data".to_string())?;

    let in_progress_state = states_data.workflow_states.nodes.first()
        .ok_or_else(|| "No 'In Progress' state found for this team".to_string())?;

    // Update the issue's state
    let update_query = format!(
        r#"mutation {{
            issueUpdate(id: "{}", input: {{ stateId: "{}" }}) {{
                success
            }}
        }}"#,
        issue_id, in_progress_state.id
    );
    let update_response = make_request(api_key, &update_query)?;
    let update: GraphQLResponse<UpdateIssueData> = serde_json::from_str(&update_response)
        .map_err(|e| format!("Failed to parse update response: {}", e))?;

    if let Some(errors) = update.errors {
        if !errors.is_empty() {
            return Err(format!("Failed to update issue: {}", errors[0].message));
        }
    }

    let update_data = update.data.ok_or_else(|| "No data in update response".to_string())?;
    if !update_data.issue_update.success {
        return Err("Failed to update issue state".to_string());
    }

    Ok(())
}

// --- HTTP helper ---

fn make_request(api_key: &str, query: &str) -> Result<String, String> {
    let body = serde_json::json!({ "query": query });

    let client = reqwest::blocking::Client::new();
    let response = client
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
