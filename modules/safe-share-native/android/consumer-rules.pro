# Reader 3 (D44): metadata-extractor and its xmpcore are looked up by reflection / resource names in places; a minified
# (R8) release build must keep them whole or the phone's own reader silently cannot read the copy (P6-3, found in P7).
-keep class com.drew.** { *; }
-keep class com.adobe.xmp.** { *; }
-dontwarn com.drew.**
-dontwarn com.adobe.xmp.**
