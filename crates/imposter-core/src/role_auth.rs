//! Pure role-delivery authorization. Sender identity MUST already be verified
//! by Holochain or the future independently accepted HWC encrypted transport.
use crate::merkle::{verify_role_proof, Hash, RoleProof};

#[allow(clippy::too_many_arguments)]
pub fn authorize_role_delivery(
    actual_sender: &[u8], lobby_host: &[u8],
    declared_recipient: &[u8], local_agent: &[u8],
    seat_owner: Option<&[u8]>,
    delivered_commitment: &[u8], accepted_commitment: &[u8],
    merkle_root: &Hash, seat: u16, role: u8, proof: &RoleProof,
) -> Result<(), &'static str> {
    if actual_sender != lobby_host {
        return Err("sender is not the lobby host");
    }
    if declared_recipient != local_agent {
        return Err("recipient is not the local agent");
    }
    if seat_owner != Some(local_agent) {
        return Err("seat is not held by the local agent");
    }
    if delivered_commitment != accepted_commitment {
        return Err("commitment is not the accepted current round");
    }
    if !verify_role_proof(merkle_root, seat, role, proof) {
        return Err("role proof does not open the accepted commitment");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::merkle::{build_layers, commitment_root, role_proof};
    const HOST: &[u8] = b"host";
    const B: &[u8] = b"guest-b";
    const C: &[u8] = b"guest-c";
    const NOW: &[u8] = b"current";
    const OLD: &[u8] = b"previous";
    fn fixture() -> (Hash, Vec<Vec<Hash>>, [u8; 32]) {
        let salt = [9u8; 32];
        let roles = [0, 1, 0];
        (commitment_root(&roles, &salt), build_layers(&roles, &salt), salt)
    }
    #[test]
    fn accepts_correct_sender_recipient_seat_commitment_and_proof() {
        let (root, layers, salt) = fixture();
        let p = role_proof(&layers, &salt, 1);
        assert_eq!(authorize_role_delivery(HOST, HOST, B, B, Some(B),
            NOW, NOW, &root, 1, 1, &p), Ok(()));
    }
    #[test]
    fn rejects_forged_sender() {
        let (root, layers, salt) = fixture();
        let p = role_proof(&layers, &salt, 1);
        assert_eq!(authorize_role_delivery(C, HOST, B, B, Some(B),
            NOW, NOW, &root, 1, 1, &p), Err("sender is not the lobby host"));
    }
    #[test]
    fn rejects_proof_for_wrong_seat_even_when_valid() {
        let (root, layers, salt) = fixture();
        let p = role_proof(&layers, &salt, 2);
        assert!(verify_role_proof(&root, 2, 0, &p));
        assert_eq!(authorize_role_delivery(HOST, HOST, B, B, Some(C),
            NOW, NOW, &root, 2, 0, &p), Err("seat is not held by the local agent"));
    }
    #[test]
    fn rejects_stale_commitment() {
        let (root, layers, salt) = fixture();
        let p = role_proof(&layers, &salt, 1);
        assert_eq!(authorize_role_delivery(HOST, HOST, B, B, Some(B),
            OLD, NOW, &root, 1, 1, &p), Err("commitment is not the accepted current round"));
    }
    #[test]
    fn rejects_substituted_recipient() {
        let (root, layers, salt) = fixture();
        let p = role_proof(&layers, &salt, 1);
        assert_eq!(authorize_role_delivery(HOST, HOST, C, B, Some(B),
            NOW, NOW, &root, 1, 1, &p), Err("recipient is not the local agent"));
    }
    #[test]
    fn rejects_bad_proof() {
        let (root, layers, salt) = fixture();
        let p = role_proof(&layers, &salt, 1);
        assert_eq!(authorize_role_delivery(HOST, HOST, B, B, Some(B),
            NOW, NOW, &root, 1, 0, &p), Err("role proof does not open the accepted commitment"));
    }
}
