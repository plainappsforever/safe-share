package expo.modules.safesharenative

import android.media.MediaMetadataRetriever
import android.net.Uri
import com.drew.imaging.ImageMetadataReader
import com.drew.lang.KeyValuePair
import com.drew.metadata.png.PngDirectory
import com.drew.metadata.xmp.XmpDirectory
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Android's independent metadata reader (SPEC F4, D11 reader 3), used only to VERIFY a cleaned copy: metadata-extractor
 * 2.21.0 (all directories and tags of images and MP4/QuickTime) plus MediaMetadataRetriever for video location/date.
 * Shares no code with the TypeScript engine. Android has no platform PDF metadata reader: PDFs report supported=false.
 * Output: JSON {reader, supported, entries: [{d: directory, t: tag, i?: tag id, v: value}], error?}.
 */
object PlatformReader {
  private val RETRIEVER_KEYS = listOf(
    MediaMetadataRetriever.METADATA_KEY_LOCATION to "location",
    MediaMetadataRetriever.METADATA_KEY_DATE to "date",
    MediaMetadataRetriever.METADATA_KEY_AUTHOR to "author",
    MediaMetadataRetriever.METADATA_KEY_ARTIST to "artist",
    MediaMetadataRetriever.METADATA_KEY_ALBUMARTIST to "albumartist",
    MediaMetadataRetriever.METADATA_KEY_COMPOSER to "composer",
    MediaMetadataRetriever.METADATA_KEY_WRITER to "writer",
    MediaMetadataRetriever.METADATA_KEY_TITLE to "title",
    MediaMetadataRetriever.METADATA_KEY_ALBUM to "album",
    MediaMetadataRetriever.METADATA_KEY_GENRE to "genre",
    MediaMetadataRetriever.METADATA_KEY_YEAR to "year",
  )

  fun fileOf(path: String): File = if (path.startsWith("file:")) File(Uri.parse(path).path ?: path) else File(path)

  fun read(path: String, kind: String): String {
    val out = JSONObject()
    val entries = JSONArray()
    out.put("supported", true)
    val file = fileOf(path)
    when (kind) {
      "image" -> {
        out.put("reader", "metadata-extractor")
        readExtractor(file, entries)?.let { out.put("error", it) }
      }
      "video" -> {
        out.put("reader", "metadata-extractor + MediaMetadataRetriever")
        val e1 = readExtractor(file, entries)
        val e2 = readRetriever(file, entries)
        // One of the two readers is enough to count; the other one's failure is recorded as an entry.
        if (e1 != null && e2 != null) out.put("error", "$e1; $e2")
        else (e1 ?: e2)?.let { add(entries, "reader-warning", "error", null, it) }
      }
      else -> {
        out.put("reader", "none")
        out.put("supported", false)
      }
    }
    out.put("entries", entries)
    return out.toString()
  }

  private fun add(entries: JSONArray, dir: String, tag: String, id: Int?, value: String?) {
    val o = JSONObject()
    o.put("d", dir)
    o.put("t", tag)
    if (id != null) o.put("i", id)
    o.put("v", value ?: "")
    entries.put(o)
  }

  /** Returns an error text when the file cannot be read at all. */
  private fun readExtractor(file: File, entries: JSONArray): String? {
    return try {
      val metadata = ImageMetadataReader.readMetadata(file)
      for (dir in metadata.directories) {
        for (tag in dir.tags) {
          val desc = try { tag.description } catch (e: Exception) { null }
          add(entries, dir.name, tag.tagName, tag.tagType, desc ?: dir.getString(tag.tagType))
        }
        if (dir is XmpDirectory) {
          try {
            for ((k, v) in dir.xmpProperties) add(entries, "XMP properties", k, null, v)
          } catch (e: Exception) {
            add(entries, dir.name, "error", null, e.toString())
          }
        }
        if (dir is PngDirectory && dir.containsTag(PngDirectory.TAG_TEXTUAL_DATA)) {
          val list = dir.getObject(PngDirectory.TAG_TEXTUAL_DATA) as? List<*>
          list?.forEach { p -> if (p is KeyValuePair) add(entries, "PNG text", p.key, null, p.value?.toString()) }
        }
        for (err in dir.errors) add(entries, dir.name, "error", null, err)
      }
      null
    } catch (e: Throwable) {
      "metadata-extractor: ${e.javaClass.simpleName}: ${e.message}"
    }
  }

  private fun readRetriever(file: File, entries: JSONArray): String? {
    val r = MediaMetadataRetriever()
    return try {
      r.setDataSource(file.absolutePath)
      for ((key, name) in RETRIEVER_KEYS) {
        val v = r.extractMetadata(key)
        if (v != null) add(entries, "MediaMetadataRetriever", name, key, v)
      }
      null
    } catch (e: Throwable) {
      "MediaMetadataRetriever: ${e.javaClass.simpleName}: ${e.message}"
    } finally {
      try { r.release() } catch (_: Throwable) {}
    }
  }
}
