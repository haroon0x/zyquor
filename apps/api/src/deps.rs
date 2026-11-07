//! App-level dependencies shared by the routes: environment merging,
//! provider factory, and a handful of derived helpers.

use std::sync::Arc;

use axum::extract::State;

use crate::state::AppState;

/// Shared handle to the app state.
pub type StateHandle = Arc<AppState>;

pub async fn state_handle(state: State<StateHandle>) -> Arc<AppState> {
    state.0.clone()
}
