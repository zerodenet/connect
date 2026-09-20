#[cfg(test)]
mod tests {
    use std::{env, fs};
    use znet_plugin_sandbox::distribution::package;

    #[test]
    fn connect_package_is_rejected_by_clean_host_capability_boundary() {
        let path = env::var("CONNECT_ZNET_PACKAGE").expect("CONNECT_ZNET_PACKAGE");
        let bytes = fs::read(path).expect("read Connect package");
        let registration = package::embedded_registration(&bytes)
            .expect("read embedded registration")
            .expect("package contains self-registration");

        let error = match package::verify_local(&bytes, &registration) {
            Ok(_) => panic!("clean host admitted unsupported Connect capabilities"),
            Err(error) => error,
        };
        let message = error.to_string();
        assert!(
            message.contains("manifest")
                || message.contains("capability")
                || message.contains("payload")
                || message.contains("unknown variant `https_origin_list`"),
            "package failed for an unrelated reason: {message}"
        );
        eprintln!("clean host correctly rejected Connect: {message}");
    }
}
