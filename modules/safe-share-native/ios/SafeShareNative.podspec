Pod::Spec.new do |s|
  s.name           = 'SafeShareNative'
  s.version        = '1.0.0'
  s.summary        = 'Safe Share platform readers, photo picker and multi-file share'
  s.description    = 'Local Expo module: ImageIO/AVFoundation/PDFKit readers used only to verify, PHPicker, UIActivityViewController'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '16.4'
  }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'ImageIO', 'AVFoundation', 'PDFKit', 'PhotosUI', 'UniformTypeIdentifiers'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
