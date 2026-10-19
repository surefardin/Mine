import express from "express";
import multer from "multer";
import AdmZip from "adm-zip";
import { spawn } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { randomUUID } from "crypto";

const app = express();
const PORT = process.env.PORT || 3000;

// Store uploads temporarily on disk
const upload = multer({ dest: path.join(os.tmpdir(), "apk-uploads") });

app.use(express.json({ limit: "5mb" })); // allow raw JSON code payloads

/* ------------------------------------------------------------------ *
 *  Helper: run a command and capture stdout/stderr
 * ------------------------------------------------------------------ */
function runCommand(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, shell: false });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`Command failed (${cmd} ${args.join(" ")}):\n${stderr || stdout}`));
    });

    child.on("error", reject);
  });
}

/* ------------------------------------------------------------------ *
 *  Helper: locate the built APK
 * ------------------------------------------------------------------ */
async function findApk(projectDir) {
  const possiblePaths = [
    "platforms/android/app/build/outputs/apk/debug/app-debug.apk",
    "platforms/android/build/outputs/apk/debug/app-debug.apk",
    "platforms/android/app/build/outputs/apk/release/app-release.apk"
  ];
  for (const rel of possiblePaths) {
    const full = path.join(projectDir, rel);
    try {
      await fs.access(full);
      return full;
    } catch { /* keep looking */ }
  }
  throw new Error("APK not found after build. Check Cordova logs.");
}

/* ------------------------------------------------------------------ *
 *  Core build routine
 * ------------------------------------------------------------------ */
async function buildApk({ sourceHtml, appName, packageId }) {
  const workDir = path.join(os.tmpdir(), `cordova-build-${randomUUID()}`);
  const wwwDir = path.join(workDir, "www");
  await fs.mkdir(wwwDir, { recursive: true });

  // 1. Write the user's HTML/JS into the Cordova www folder
  await fs.writeFile(path.join(wwwDir, "index.html"), sourceHtml, "utf8");

  // 2. Create the Cordova project (this also creates config.xml)
  await runCommand(
    "cordova",
    ["create", workDir, packageId, appName],
    process.cwd()
  );

  // The create command may create the project in workDir; ensure www exists
  // (cordova create uses the directory as the project root)
  await fs.mkdir(path.join(workDir, "www"), { recursive: true });
  await fs.writeFile(path.join(workDir, "www", "index.html"), sourceHtml, "utf8");

  // 3. Add the Android platform
  await runCommand("cordova", ["platform", "add", "android"], workDir);

  // 4. Build a debug APK (use ["build", "android", "--release"] for a release build;
  //    release builds require a keystore configuration)
  await runCommand("cordova", ["build", "android"], workDir);

  // 5. Locate the APK
  const apkPath = await findApk(workDir);
  return { apkPath, workDir };
}

/* ------------------------------------------------------------------ *
 *  API endpoint – accepts EITHER:
 *    • multipart/form-data with a .zip file (field name: "project")
 *    • JSON body: { code: "<html…>", appName, packageId }
 * ------------------------------------------------------------------ */
app.post("/api/build-apk", upload.single("project"), async (req, res) => {
  let workDirToClean = null;

  try {
    let sourceHtml;
    let appName = "MyApp";
    let packageId = "com.example.myapp";

    /* ---- Case A: ZIP upload ---- */
    if (req.file) {
      const zip = new AdmZip(req.file.path);
      const entries = zip.getEntries();

      // Find index.html (or the first .html file)
      const htmlEntry = entries.find((e) => e.entryName.endsWith("index.html"))
        || entries.find((e) => e.entryName.endsWith(".html"));

      if (!htmlEntry) {
        return res.status(400).json({ error: "ZIP must contain an index.html or other .html file." });
      }

      sourceHtml = htmlEntry.getData().toString("utf8");

      // Optional metadata from form fields
      if (req.body.appName) appName = req.body.appName;
      if (req.body.packageId) packageId = req.body.packageId;

      // Cleanup uploaded temp file
      await fs.unlink(req.file.path).catch(() => {});
    }
    /* ---- Case B: JSON with raw code ---- */
    else if (req.body && req.body.code) {
      sourceHtml = req.body.code;
      if (req.body.appName) appName = req.body.appName;
      if (req.body.packageId) packageId = req.body.packageId;
    }
    else {
      return res.status(400).json({ error: "Provide a ZIP file (field 'project') or a JSON body with 'code'." });
    }

    /* ---- Build ---- */
    const { apkPath, workDir } = await buildApk({ sourceHtml, appName, packageId });
    workDirToClean = workDir;

    /* ---- Send APK to client ---- */
    res.download(apkPath, `${appName.replace(/\s+/g, "_")}.apk`, async (err) => {
      // Clean up the temporary build directory after the download finishes
      if (workDirToClean) {
        await fs.rm(workDirToClean, { recursive: true, force: true }).catch(() => {});
      }
      if (err) console.error("Download error:", err);
    });
  } catch (err) {
    console.error("Build failed:", err);

    // Clean up even on failure
    if (workDirToClean) {
      await fs.rm(workDirToClean, { recursive: true, force: true }).catch(() => {});
    }

    res.status(500).json({
      error: "APK build failed. Check server logs for details.",
      detail: err.message
    });
  }
});

/* ------------------------------------------------------------------ *
 *  Health check
 * ------------------------------------------------------------------ */
app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.listen(PORT, () => {
  console.log(`APK builder server listening on http://localhost:${PORT}`);
});
