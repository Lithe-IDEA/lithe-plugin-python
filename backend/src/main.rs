//! Package-local startup for the Python plugin's language server and toolchain provider.

mod discovery;
mod inspect;
mod pyrefly;
mod requirements;
mod settings_preview;

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
        .view(settings_preview::FUNCTION, settings_preview::draw)
        .expect("the preview function ID is valid")
        .suppress_success_diagnostics(settings_preview::FUNCTION)
        .expect("the preview function is registered")
        .toolchain_provider("python", discovery::query)
        .expect("the Python provider ID is valid");
    std::process::exit(backend.listen());
}
