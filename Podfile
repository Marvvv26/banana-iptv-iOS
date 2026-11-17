platform :ios, '15.0'
use_frameworks!
inhibit_all_warnings!

target 'BananaIPTV' do
  # VideoLAN's player engine for iOS (the same libVLC the Fire TV app uses).
  pod 'MobileVLCKit', '~> 3.5'
end

post_install do |installer|
  installer.pods_project.targets.each do |t|
    t.build_configurations.each do |c|
      c.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '15.0'
    end
  end
end
