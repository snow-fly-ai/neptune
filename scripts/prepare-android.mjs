// Runs in CI after `tauri android init`: installs our MainActivity and launcher
// icons, and wires release signing to the keystore described by gen/android/keystore.properties.
import { copyFileSync, cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const gen = 'src-tauri/gen/android';
const activity = join(gen, 'app/src/main/java/com/snowfly/nebula/MainActivity.kt');
if (!existsSync(activity)) throw new Error(`Expected generated activity at ${activity}`);
copyFileSync('android/MainActivity.kt', activity);

// `tauri android init` generates the project with Tauri's stock launcher icon.
cpSync('src-tauri/icons/android', join(gen, 'app/src/main/res'), { recursive: true, force: true });

const gradlePath = join(gen, 'app/build.gradle.kts');
let gradle = readFileSync(gradlePath, 'utf8');

if (!gradle.includes('signingConfigs')) {
  // Inside `android {}` a bare `java.` resolves to the Android `java` extension,
  // so these must be imported rather than fully qualified.
  for (const imp of ['java.io.FileInputStream', 'java.util.Properties']) {
    if (!gradle.includes(`import ${imp}\n`)) gradle = `import ${imp}\n${gradle}`;
  }
  gradle = gradle.replace(
    /android \{\n/,
    `android {
    signingConfigs {
        create("release") {
            val keystorePropertiesFile = rootProject.file("keystore.properties")
            val keystoreProperties = Properties()
            if (keystorePropertiesFile.exists()) {
                keystoreProperties.load(FileInputStream(keystorePropertiesFile))
            }
            keyAlias = keystoreProperties["keyAlias"] as String
            keyPassword = keystoreProperties["password"] as String
            storeFile = file(keystoreProperties["storeFile"] as String)
            storePassword = keystoreProperties["password"] as String
        }
    }
`,
  );
  gradle = gradle.replace(
    /getByName\("release"\) \{\n/,
    `getByName("release") {\n            signingConfig = signingConfigs.getByName("release")\n`,
  );
}
if (!gradle.includes('signingConfigs.getByName("release")')) {
  throw new Error('Failed to patch release signing into build.gradle.kts');
}
writeFileSync(gradlePath, gradle);
console.log('Android project prepared');
