# Android release key — what the owner runs

The release workflow (`.github/workflows/release-android.yml`, ADR 0021) signs the APKs and the
AAB with a key it reads from GitHub Actions secrets. The keystore is made on your machine, goes
straight into the secrets and into your offline backups. It never enters the repository, a chat,
a log or an issue. Without the secrets the workflow still builds and checks everything and
leaves the artifacts unsigned (a notice says so).

Requirements (Play Console Help, "Use Play App Signing",
<https://support.google.com/googleplay/android-developer/answer/9842756>): upload and custom app
signing keys are RSA ≥ 2048 bits. We use RSA 4096 and 10 000 days of validity.

## 0. Decide first: one key everywhere, or Google's key on Play

Android installs an update only when it is signed with the same key as the installed app. Selis
ships through Google Play, GitHub Releases (Obtainium) and F-Droid, and F-Droid can publish our
own signed APK when its build is byte-identical (reproducible builds, `docs/store/fdroid/`).

| | A — one key everywhere (recommended) | B — Google-generated key on Play |
| --- | --- | --- |
| Play app signing key | ours (uploaded once when the app is created: "Provide a copy of your app signing key") | Google's (Play now enrols new apps in "quantum-ready, hybrid signing with Google-generated keys") |
| Play, GitHub and F-Droid installs | update each other | Play ↔ GitHub/F-Droid needs an uninstall (library lost unless moved first) |
| If our key leaks or is lost | no rotation path outside Play; GitHub/F-Droid users must reinstall | Play is unaffected; GitHub/F-Droid as in A |
| Upload key | a separate upload key (Google recommends upload ≠ app signing key) | a separate upload key |

Both need the release key below. Option B, and option A done as Google recommends, also need the
separate upload key (step 3). Tell me A or B; the store checklist follows it.

## 1. Make the release key (once, on your PC)

PowerShell, in a folder outside the repository (for example `D:\keys`), with JDK 17's `keytool`
(`C:\Program Files\Eclipse Adoptium\jdk-17*\bin`):

```powershell
keytool -genkeypair -v -keystore selis-release.jks -storetype PKCS12 `
  -alias selis -keyalg RSA -keysize 4096 -validity 10000 `
  -dname "CN=Any WeCon, O=Any WeCon, C=GR"
```

It asks for a password twice (PKCS12: the store and the key share it). Use a long random one
from your password manager.

Certificate fingerprint (public; F-Droid's `AllowedAPKSigningKeys` needs it in lowercase hex
without colons; send me this line, nothing else):

```powershell
keytool -list -v -keystore selis-release.jks -alias selis | Select-String "SHA256:"
```

## 2. Put it into GitHub secrets

`gh` reads secret values from stdin or prompts for them, so nothing lands in the shell history:

```powershell
cd D:\keys
[Convert]::ToBase64String([IO.File]::ReadAllBytes("selis-release.jks")) | gh secret set ANDROID_KEYSTORE_BASE64 -R Fiouri/selis
gh secret set ANDROID_KEYSTORE_PASSWORD -R Fiouri/selis   # paste the password at the prompt
gh secret set ANDROID_KEY_PASSWORD -R Fiouri/selis        # the same password (PKCS12)
gh secret set ANDROID_KEY_ALIAS -R Fiouri/selis --body selis
```

Check (names only, values are never shown): `gh secret list -R Fiouri/selis`.

## 3. Separate upload key (option B, or A as Google recommends)

```powershell
keytool -genkeypair -v -keystore selis-upload.jks -storetype PKCS12 `
  -alias selis-upload -keyalg RSA -keysize 4096 -validity 10000 `
  -dname "CN=Any WeCon upload, O=Any WeCon, C=GR"
keytool -export -rfc -keystore selis-upload.jks -alias selis-upload -file selis-upload.pem
[Convert]::ToBase64String([IO.File]::ReadAllBytes("selis-upload.jks")) | gh secret set ANDROID_UPLOAD_KEYSTORE_BASE64 -R Fiouri/selis
gh secret set ANDROID_UPLOAD_KEYSTORE_PASSWORD -R Fiouri/selis
gh secret set ANDROID_UPLOAD_KEY_PASSWORD -R Fiouri/selis
gh secret set ANDROID_UPLOAD_KEY_ALIAS -R Fiouri/selis --body selis-upload
```

`selis-upload.pem` is what Play Console asks for as the upload certificate. When the upload
secrets are set, the AAB is signed with the upload key; the APKs always use the release key. A
lost upload key can be reset by Google; a lost release key cannot be replaced for GitHub and
F-Droid users.

## 4. Back up, then delete the working copy

- Two offline copies of each `.jks` (an encrypted USB stick and your password manager's file
  attachment), each with its password stored separately.
- Then delete the `.jks` from `D:\keys` if it is not your backup location.

## 5. Check

Run the workflow by hand (Actions › Android release › Run workflow) or push a tag (after I ask).
The "Sign" step must say `signed …` for six files and "Signature checks" must pass (APK
Signature Scheme v2 + v3, jarsigner for the AAB).
