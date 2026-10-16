package expo.modules.safesharenative

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.ClipData
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.ext.SdkExtensions
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream

/**
 * Safe Share's local native module (V1_PLAN P6). The TypeScript engine stays the only cleaner; this module adds the
 * platform reader used to verify (PlatformReader.kt), the system photo picker with the original-location request,
 * multi-file share, display names of shared files and saving to the right MediaStore collection.
 */
class SafeShareNativeModule : Module() {
  private var pickPromise: Promise? = null
  private var pickDest: File? = null
  private var pickOriginal = false

  private val context: Context
    get() = appContext.reactContext ?: throw CodedException("E_NO_CONTEXT", "React context lost", null)

  override fun definition() = ModuleDefinition {
    Name("SafeShareNative")

    AsyncFunction("readPlatformMetadata") { path: String, kind: String ->
      PlatformReader.read(path, kind)
    }

    Function("isPhotoPickerAvailable") { photoPickerAvailable() }

    AsyncFunction("pickMedia") { limit: Int, destDir: String, requireOriginal: Boolean, promise: Promise ->
      val activity = appContext.currentActivity
      if (activity == null) {
        promise.reject("E_NO_ACTIVITY", "No activity to open the photo picker from", null)
        return@AsyncFunction
      }
      if (pickPromise != null) {
        promise.reject("E_BUSY", "The photo picker is already open", null)
        return@AsyncFunction
      }
      if (!photoPickerAvailable()) {
        promise.reject("E_NO_PICKER", "The system photo picker is not available", null)
        return@AsyncFunction
      }
      // No type set: the photo picker offers photos and videos. No permission is needed to pick.
      val intent = Intent(MediaStore.ACTION_PICK_IMAGES)
      if (limit != 1) intent.putExtra(MediaStore.EXTRA_PICK_IMAGES_MAX, pickMax(limit))
      pickPromise = promise
      pickDest = PlatformReader.fileOf(destDir)
      pickOriginal = requireOriginal
      try {
        activity.startActivityForResult(intent, PICK_REQUEST)
      } catch (e: Exception) {
        pickPromise = null
        promise.reject("E_NO_PICKER", e.message, e)
      }
    }.runOnQueue(Queues.MAIN)

    OnActivityResult { _, payload ->
      if (payload.requestCode != PICK_REQUEST) return@OnActivityResult
      val promise = pickPromise ?: return@OnActivityResult
      val dest = pickDest
      val original = pickOriginal
      pickPromise = null
      pickDest = null
      val data = payload.data
      if (payload.resultCode != Activity.RESULT_OK || data == null || dest == null) {
        promise.resolve(emptyList<Any>())
        return@OnActivityResult
      }
      val uris = mutableListOf<Uri>()
      val clip = data.clipData
      if (clip != null) {
        for (i in 0 until clip.itemCount) clip.getItemAt(i).uri?.let { uris.add(it) }
      } else {
        data.data?.let { uris.add(it) }
      }
      // Copying a large video must not block the main thread.
      Thread {
        try {
          dest.mkdirs()
          promise.resolve(uris.mapIndexed { i, uri -> copyPicked(uri, dest, i, original) })
        } catch (e: Throwable) {
          promise.reject("E_PICK_COPY", e.message, e)
        }
      }.start()
    }

    /** `MediaStore.setRequireOriginal` (with ACCESS_MEDIA_LOCATION this asks for the unredacted bytes). */
    Function("requireOriginal") { uri: String ->
      if (Build.VERSION.SDK_INT >= 29) MediaStore.setRequireOriginal(Uri.parse(uri)).toString() else uri
    }

    /** The provider's display name of a shared file (OpenableColumns.DISPLAY_NAME), or null. */
    Function("displayName") { uri: String -> displayName(Uri.parse(uri)) }

    AsyncFunction("shareFiles") { uris: List<String>, mimeTypes: List<String>, title: String ->
      val activity = appContext.currentActivity ?: throw CodedException("E_NO_ACTIVITY", "No activity", null)
      if (uris.isEmpty()) return@AsyncFunction false
      val list = ArrayList(uris.map { Uri.parse(it) })
      val intent = if (list.size == 1) {
        Intent(Intent.ACTION_SEND).putExtra(Intent.EXTRA_STREAM, list[0])
      } else {
        Intent(Intent.ACTION_SEND_MULTIPLE).putParcelableArrayListExtra(Intent.EXTRA_STREAM, list)
      }
      intent.type = commonMime(mimeTypes)
      // The read grant travels with the ClipData to the chooser and the chosen app.
      val clip = ClipData.newRawUri("", list[0])
      for (u in list.drop(1)) clip.addItem(ClipData.Item(u))
      intent.clipData = clip
      intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      activity.startActivity(Intent.createChooser(intent, title))
      true
    }.runOnQueue(Queues.MAIN)

    /**
     * Android 10+: copies a cleaned file into Pictures/, Movies/ or Download/<folder> through MediaStore (no permission for
     * the app's own files). Byte copy; returns "<relative path><display name>" as MediaStore stored it.
     */
    AsyncFunction("saveToMediaStore") { path: String, name: String, mimeType: String, collection: String, folder: String ->
      if (Build.VERSION.SDK_INT < 29) throw CodedException("E_OLD_ANDROID", "Needs Android 10", null)
      saveToMediaStore(PlatformReader.fileOf(path), name, mimeType, collection, folder)
    }
  }

  @SuppressLint("NewApi")
  private fun photoPickerAvailable(): Boolean =
    Build.VERSION.SDK_INT >= 33 || (Build.VERSION.SDK_INT >= 30 && SdkExtensions.getExtensionVersion(Build.VERSION_CODES.R) >= 2)

  @SuppressLint("NewApi")
  private fun pickMax(limit: Int): Int {
    val max = MediaStore.getPickImagesMaxLimit()
    return if (limit <= 0) max else minOf(limit, max)
  }

  private fun hasMediaLocation(): Boolean =
    Build.VERSION.SDK_INT >= 29 &&
      context.checkSelfPermission(Manifest.permission.ACCESS_MEDIA_LOCATION) == PackageManager.PERMISSION_GRANTED

  private fun displayName(uri: Uri): String? = try {
    context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
      if (c.moveToFirst() && !c.isNull(0)) c.getString(0) else null
    }
  } catch (e: Exception) {
    null
  }

  /**
   * Copies one picked item. With ACCESS_MEDIA_LOCATION granted and `original` asked for, the picker URI is first read with
   * setRequireOriginal (the photo picker blanks GPS otherwise, V1_LOG P5); if that is refused, the default copy is used.
   */
  @SuppressLint("NewApi")
  private fun copyPicked(uri: Uri, dest: File, index: Int, original: Boolean): Map<String, Any?> {
    val resolver = context.contentResolver
    val mime = resolver.getType(uri)
    var name = displayName(uri) ?: "file-$index"
    if (!name.contains('.')) {
      MimeTypeMap.getSingleton().getExtensionFromMimeType(mime)?.let { name = "$name.$it" }
    }
    name = name.replace('/', '_')
    val target = File(dest, "$index-$name")
    var gotOriginal = false
    if (original && hasMediaLocation()) {
      try {
        resolver.openInputStream(MediaStore.setRequireOriginal(uri))?.use { input ->
          FileOutputStream(target).use { input.copyTo(it, 1 shl 20) }
          gotOriginal = true
        }
      } catch (e: Exception) {
        target.delete()
      }
    }
    if (!gotOriginal) {
      resolver.openInputStream(uri)?.use { input ->
        FileOutputStream(target).use { input.copyTo(it, 1 shl 20) }
      } ?: throw IllegalStateException("cannot open $uri")
    }
    return mapOf(
      "path" to Uri.fromFile(target).toString(),
      "name" to name,
      "uri" to uri.toString(),
      "mimeType" to mime,
      "original" to gotOriginal,
    )
  }

  @SuppressLint("NewApi")
  private fun saveToMediaStore(file: File, name: String, mimeType: String, collection: String, folder: String): String {
    val resolver = context.contentResolver
    val volume = MediaStore.VOLUME_EXTERNAL_PRIMARY
    val (table, dir) = when (collection) {
      "images" -> MediaStore.Images.Media.getContentUri(volume) to Environment.DIRECTORY_PICTURES
      "video" -> MediaStore.Video.Media.getContentUri(volume) to Environment.DIRECTORY_MOVIES
      else -> MediaStore.Downloads.getContentUri(volume) to Environment.DIRECTORY_DOWNLOADS
    }
    val relative = "$dir/$folder/"
    val values = ContentValues().apply {
      put(MediaStore.MediaColumns.DISPLAY_NAME, name)
      put(MediaStore.MediaColumns.MIME_TYPE, mimeType)
      put(MediaStore.MediaColumns.RELATIVE_PATH, relative)
      put(MediaStore.MediaColumns.IS_PENDING, 1)
    }
    val uri = resolver.insert(table, values) ?: throw IllegalStateException("MediaStore refused the new file")
    try {
      resolver.openOutputStream(uri, "w")?.use { out ->
        FileInputStream(file).use { it.copyTo(out, 1 shl 20) }
      } ?: throw IllegalStateException("cannot write $uri")
      val done = ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }
      resolver.update(uri, done, null, null)
    } catch (e: Exception) {
      resolver.delete(uri, null, null)
      throw e
    }
    val stored = displayName(uri) ?: name
    return relative + stored
  }

  private fun commonMime(types: List<String>): String {
    val distinct = types.map { it.lowercase() }.distinct()
    if (distinct.size == 1) return distinct[0]
    val tops = distinct.map { it.substringBefore('/') }.distinct()
    return if (tops.size == 1) "${tops[0]}/*" else "*/*"
  }

  companion object {
    private const val PICK_REQUEST = 0x5AFE
  }
}
