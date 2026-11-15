buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath("com.android.tools.build:gradle:9.3.1")
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:2.2.10")
    }
}

allprojects {
    repositories {
        google()
        mavenCentral()
    }
}

subprojects {
    if (!projectDir.toPath().normalize().startsWith(rootProject.projectDir.toPath().normalize())) {
        // Keep dependency build outputs local to this Android project.
        layout.buildDirectory.set(rootProject.layout.buildDirectory.dir("tauri-plugins/$name"))
    }
}

tasks.register("clean").configure {
    delete("build")
}

