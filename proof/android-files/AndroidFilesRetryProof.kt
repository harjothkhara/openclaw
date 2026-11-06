package ai.openclaw.app

import ai.openclaw.releasevalidation.ReleaseValidationUi
import android.content.Intent
import android.os.SystemClock
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.StaleObjectException
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.URL

/** FORK-ONLY instrumentation overlay: normal APK launcher and native input, never app handlers/state. */
@RunWith(AndroidJUnit4::class)
class AndroidFilesRetryProof {
  @Test
  fun normalAppFilesRetry() {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val context = instrumentation.targetContext
    val arguments = InstrumentationRegistry.getArguments()
    val expectedStale = arguments.getString("expectedStaleError") == "true"
    val port = checkNotNull(arguments.getString("proxyPort")).toInt()
    val expectedSource = checkNotNull(arguments.getString("expectedSourceSha"))
    val apkGitCommit = Class.forName("ai.openclaw.app.BuildConfig", true, context.classLoader)
      .getField("GIT_COMMIT").get(null) as String
    assertEquals("Normal APK BuildConfig identity differs from checkout", expectedSource, apkGitCommit)
    val revision = checkNotNull(arguments.getString("proofRevision"))
    check(revision in listOf("baseline", "candidate"))
    val input = File(context.filesDir, "native-files-setup-code")
    val setupCode = input.readText().trim()
    check(setupCode.isNotEmpty())
    check(input.delete())
    val output = File(context.filesDir, "native-files-proof").apply { mkdirs() }
    val ui = ReleaseValidationUi(instrumentation)
    val mainSidebar = By.pkg(context.packageName).desc("Show Sidebar")
    fun snapshot(name: String) {
      val xml = File(output, name + ".xml")
      ui.device.dumpWindowHierarchy(xml)
      val raw = xml.readText()
      xml.writeText(raw.replace(setupCode, "[REDACTED_SETUP_CODE]"))
      // Never retain a screenshot when a setup code could be visible.
      if (!raw.contains(setupCode)) assertTrue(ui.device.takeScreenshot(File(output, name + ".png")))
    }
    fun seek(selector: BySelector, forward: Boolean): UiObject2 {
      repeat(72) {
        try {
          ui.device.findObject(selector)?.let { node ->
            if (node.visibleBounds.height() > 12 && node.visibleCenter.y in 60 until ui.device.displayHeight - 60) return node
          }
        } catch (_: StaleObjectException) {
          // Compose can replace a row during scrolling; reacquire it before any action.
        }
        ui.swipe(forward)
      }
      return ui.requireObject(selector, "Public UI target not reached by bounded native scrolling", 2_000)
    }
    fun top() {
      seek(By.text("file-000.txt"), false)
      repeat(3) { ui.swipe(false) }
      ui.requireObject(By.text("file-000.txt"), "Already-loaded first file disappeared")
      ui.requireObject(By.text("retry-proof"), "Folder header not visible at the beginning")
      ui.requireObject(By.desc("Refresh"), "Same Files screen is no longer connected")
    }
    fun status(): JSONObject = URL("http://127.0.0.1:" + port + "/proof-status").openConnection().apply {
      connectTimeout = 2_000
      readTimeout = 2_000
    }.getInputStream().use { JSONObject(it.bufferedReader().readText()) }
    fun awaitStatus(predicate: (JSONObject) -> Boolean) {
      val end = SystemClock.elapsedRealtime() + 30_000
      while (SystemClock.elapsedRealtime() < end) {
        if (predicate(status())) return
        Thread.sleep(100)
      }
      error("Bounded real-Gateway RPC observation timed out")
    }
    try {
      val launchIntent = checkNotNull(context.packageManager.getLaunchIntentForPackage(context.packageName)) {
        "Packaged app has no public launcher intent"
      }
      context.startActivity(launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      assertTrue("Launcher did not foreground the packaged app", ui.device.wait(
        Condition<UiDevice, Boolean> { ui.device.currentPackageName == context.packageName }, 30_000))
      snapshot("00-normal-launch")
      ui.clickText("Continue")
      ui.clickText("Scan QR or setup code")
      ui.clickText("Enter setup code")
      ui.requireObject(By.clazz("android.widget.EditText"), "Normal setup-code field missing").text = setupCode
      ui.clickText("Use setup code")
      ui.requireObject(By.text("Gateway paired"), "Real Gateway setup-code pairing did not complete", 60_000)
      snapshot("01-gateway-paired")
      var complete = false
      repeat(6) {
        if (!complete) {
          val next = ui.device.wait(Condition<UiDevice, String?> {
            when {
              ui.device.hasObject(mainSidebar) -> "done"
              ui.device.hasObject(By.text("Approve access and continue").enabled(true)) -> "Approve access and continue"
              ui.device.hasObject(By.text("Continue").enabled(true)) -> "Continue"
              else -> null
            }
          }, 30_000)
          checkNotNull(next) { "Normal onboarding did not reach a continuation" }
          if (next == "done") {
            complete = true
          } else {
            try {
              ui.clickText(next)
            } catch (failure: IllegalStateException) {
              // Onboarding can finish while a continuation tap is being prepared.
              // Accept that race only when the same app exposes its terminal sidebar.
              if (ui.device.wait(Until.hasObject(mainSidebar), 5_000) == true) complete = true else throw failure
            }
          }
        }
      }
      ui.requireObject(mainSidebar, "Normal onboarding did not reach the main app").click()
      ui.clickText("Overview")
      ui.requireObject(By.text("Online"), "Real Gateway is not online", 30_000)
      seek(By.text("Files"), true)
      ui.clickText("Files")
      ui.requireObject(By.text("retry-proof"), "Seeded child folder is missing", 30_000)
      ui.clickText("retry-proof")
      ui.requireObject(By.text("file-000.txt"), "Normal Files navigation did not load the real first page", 30_000)
      awaitStatus { it.getInt("firstPages") >= 1 }
      snapshot("02-files-first-page")
      seek(By.text("Load more"), true)
      ui.requireObject(By.text("250 of 251"), "Default 250-entry page not observed")
      snapshot("03-before-load-more")
      ui.clickText("Load more")
      awaitStatus { it.getInt("faults") == 1 }
      top()
      ui.requireObject(By.text("Files unavailable"), "Failed append did not expose its error")
      ui.requireObject(By.text("Could not load this folder."), "Expected failed-list message missing")
      snapshot("04-failed-append-retains-rows")
      seek(By.text("Load more"), true)
      ui.requireObject(By.text("file-249.txt"), "Already-loaded last file disappeared")
      ui.requireObject(By.text("250 of 251"), "Failed append changed the retained row count")
      ui.clickText("Load more")
      awaitStatus { it.getInt("finalPages") >= 1 }
      seek(By.text("file-250.txt"), true)
      // Reach the list end so an offscreen button cannot satisfy the absence check.
      repeat(3) { ui.swipe(true) }
      ui.requireObject(By.text("file-250.txt"), "Final file is missing at the list end")
      ui.requireObject(By.text("file-249.txt"), "Retry lost the previous page tail")
      assertFalse("Load more remains after all 251 files loaded", ui.device.hasObject(By.text("Load more")))
      snapshot("05-successful-retry-tail")
      assertEquals("Retry must not reload the first page", 1, status().getInt("firstPages"))
      top()
      assertEquals("Scrolling to the header must not reload the first page", 1, status().getInt("firstPages"))
      val observed = ui.device.hasObject(By.text("Files unavailable"))
      snapshot("06-successful-retry-top")
      val facts = JSONObject().put("revision", revision).put("apkGitCommit", apkGitCommit)
        .put("visibleFirstFileAndHeaderAtBeginning", true).put("connectedRefreshControlVisible", true)
        .put("normalLauncher", true)
        .put("normalSetupCodeOnboarding", true).put("normalFilesNavigation", true)
        .put("initialRows", 250).put("totalRows", 251).put("firstAndPreviousTailRetained", true)
        .put("successfulFinalRowObserved", true).put("staleErrorAfterSuccess", observed)
        .put("expectedStaleError", expectedStale).put("rpc", status())
      File(output, "facts.json").writeText(facts.toString(2))
      assertEquals("Native stale-error outcome differs from this source revision", expectedStale, observed)
      if (!expectedStale) assertFalse(ui.device.hasObject(By.text("Could not load this folder.")))
    } catch (failure: Throwable) {
      snapshot("failure-state")
      throw failure
    }
  }
}

