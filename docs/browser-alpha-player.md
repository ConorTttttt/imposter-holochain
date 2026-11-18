# Imposter RC1 player installation

1. Get the operator’s HTTPS setup link, `chromium-hwc.zip` and its expected SHA-256. Verify the archive before unpacking it. On Linux, run `sha256sum chromium-hwc.zip` and compare the result with the operator’s checksum.
2. Open your own persistent Chromium profile. In `chrome://extensions`, enable **Developer mode**, select **Load unpacked**, then choose the extracted directory containing `manifest.json`. Keep that directory in the same location.
3. Open the operator’s setup link and select **Connect HWC**. Approve the site in HWC. Copy the public player key shown on the page and share it with the operator for admission.
4. After admission, choose **Install game and connect**. The page checks the downloaded hApp, installed DNA and secure gateway session. Select **Open lobby** when it becomes available.
5. Join the same lobby as the other two players. When the host starts, each profile displays its own verified role. A crewmate completes **Align Engine Output** to finish the supported round.

If HWC is missing after reload, use the profile that loaded the extension. If admission is pending, confirm the public key with the operator and select **Reconnect**. If the page reports a different installed game or a checksum mismatch, share the exact error and return to the correct site and profile. For browser restart, reopen the same Chromium profile and the same setup link.

Share your public player key and the setup page’s error text with the operator. Keep your role, Chromium profile data and browser diagnostics private. During acceptance, keep the same profile and extension directory across restart and wait for the operator’s instructions before reconnecting after revocation.
