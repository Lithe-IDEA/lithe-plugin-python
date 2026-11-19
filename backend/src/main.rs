//! Package-local startup for the Python plugin's language server and toolchain provider.

mod discovery;
mod inspect;
mod pyrefly;
mod requirements;

use lithe_plugin_sdk::Backend;

fn main() {
    let mut backend = Backend::new("python-support-backend");
    let launch = pyrefly::LaunchResolver::default();
    backend
        .function("pyrefly.resolveLaunch", move |params, context| {
            launch.resolve(params, context)
        })
        .expect("the Pyrefly function ID is valid")
        .function(inspect::FUNCTION, inspect::environment)
        .expect("the inspect function ID is valid")
        .suppress_success_diagnostics(inspect::FUNCTION)
        .expect("the inspect function is registered")
        .toolchain_provider("python", discovery::query)
        .expect("the Python provider ID is valid");
    std::process::exit(backend.listen());
}
