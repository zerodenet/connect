#[cfg(test)]
mod tests {
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    use hpke::{
        Deserializable, Kem as KemTrait, OpModeR, aead::ChaCha20Poly1305, kdf::HkdfSha256,
        kem::X25519HkdfSha256, setup_receiver,
    };
    use serde::Deserialize;

    type Kem = X25519HkdfSha256;
    type Aead = ChaCha20Poly1305;
    type Kdf = HkdfSha256;

    #[derive(Deserialize)]
    struct Vectors {
        schema_version: u8,
        suite: String,
        provider: KeyPair,
        client_response: KeyPair,
        request: Message,
        response: Message,
    }

    #[derive(Deserialize)]
    struct KeyPair {
        public_key: String,
        private_key: String,
    }

    #[derive(Deserialize)]
    struct Message {
        info: String,
        aad: String,
        plaintext: String,
        envelope: Envelope,
    }

    #[derive(Deserialize)]
    struct Envelope {
        encapsulation: String,
        ciphertext: String,
    }

    #[test]
    fn rust_opens_go_base_request_and_authenticated_response() {
        let vectors: Vectors = serde_json::from_str(include_str!("../../../testdata/vectors.json"))
            .expect("valid vector JSON");
        assert_eq!(vectors.schema_version, 1);
        assert_eq!(vectors.suite, "HPKE-0x0020-0x0001-0x0003");

        let provider_private = private_key(&vectors.provider.private_key);
        let request_encapsulation = encapsulation(&vectors.request.envelope.encapsulation);
        let mut request_context = setup_receiver::<Aead, Kdf, Kem>(
            &OpModeR::Base,
            &provider_private,
            &request_encapsulation,
            &decode(&vectors.request.info),
        )
        .expect("set up base-mode request receiver");
        let request_plaintext = request_context
            .open(
                &decode(&vectors.request.envelope.ciphertext),
                &decode(&vectors.request.aad),
            )
            .expect("open Go request vector");
        assert_eq!(request_plaintext, decode(&vectors.request.plaintext));

        let client_private = private_key(&vectors.client_response.private_key);
        let provider_public = public_key(&vectors.provider.public_key);
        let response_encapsulation = encapsulation(&vectors.response.envelope.encapsulation);
        let mut response_context = setup_receiver::<Aead, Kdf, Kem>(
            &OpModeR::Auth(provider_public),
            &client_private,
            &response_encapsulation,
            &decode(&vectors.response.info),
        )
        .expect("set up authenticated response receiver");
        let response_plaintext = response_context
            .open(
                &decode(&vectors.response.envelope.ciphertext),
                &decode(&vectors.response.aad),
            )
            .expect("open Go response vector");
        assert_eq!(response_plaintext, decode(&vectors.response.plaintext));
    }

    fn decode(value: &str) -> Vec<u8> {
        URL_SAFE_NO_PAD.decode(value).expect("base64url without padding")
    }

    fn private_key(value: &str) -> <Kem as KemTrait>::PrivateKey {
        <<Kem as KemTrait>::PrivateKey as Deserializable>::from_bytes(&decode(value))
            .expect("valid X25519 private key")
    }

    fn public_key(value: &str) -> <Kem as KemTrait>::PublicKey {
        <<Kem as KemTrait>::PublicKey as Deserializable>::from_bytes(&decode(value))
            .expect("valid X25519 public key")
    }

    fn encapsulation(value: &str) -> <Kem as KemTrait>::EncappedKey {
        <<Kem as KemTrait>::EncappedKey as Deserializable>::from_bytes(&decode(value))
            .expect("valid X25519 encapsulated key")
    }
}
