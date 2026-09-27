#[cfg(test)]
mod tests {
    use std::{env, fs};
    use znet_plugin_sandbox::distribution::package;
    use znet_sink_plugin_sdk::Method;

    #[test]
    fn clean_host_sdk_exposes_managed_subscription_metadata_update() {
        assert_eq!(
            serde_json::to_string(&Method::SubscriptionMetadataUpdate).unwrap(),
            "\"subscription_metadata_update\""
        );
    }

    #[test]
    fn connect_application_package_is_accepted_by_clean_host() {
        let path = env::var("CONNECT_ZNET_PACKAGE").expect("CONNECT_ZNET_PACKAGE");
        let bytes = fs::read(path).expect("read Connect package");
        let registration = package::embedded_registration(&bytes)
            .expect("read embedded registration")
            .expect("package contains self-registration");

        let verified = package::verify_local(&bytes, &registration)
            .expect("clean host accepts the signed application package");
        assert_eq!(verified.id, "org.zerodenet.connect.znet-sink");
        assert_eq!(verified.components.len(), 1);
        assert_eq!(verified.pages.len(), 1);
    }
}
