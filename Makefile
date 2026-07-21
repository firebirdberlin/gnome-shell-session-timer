UUID = gnome-shell-session-timer@firebirdberlin
DIST_DIR = dist

.PHONY: all bump pack release clean test

all: pack

# Get the current version-name directly from metadata.json.
# EGO (extensions.gnome.org) ignores/overwrites the integer "version" field
# on upload, so version-name is our own date-based versioning scheme instead.
VERSION_NAME = $(shell python3 -c "import json; print(json.load(open('metadata.json'))['version-name'])")
ZIP_FILE = $(DIST_DIR)/$(UUID)-v$(VERSION_NAME).shell-extension.zip

# 1. Sets version-name to today's date (YYYY.MM.DD), or appends/increments a
#    ".N" suffix if a release has already happened today. Also increments the
#    integer "version" field for local bookkeeping (EGO overwrites it anyway).
bump:
	@echo "Current version-name is $(VERSION_NAME)"
	@python3 bump-version.py
	@echo "Version bumped to $$(python3 -c "import json; print(json.load(open('metadata.json'))['version-name'])")"

# 2. Packages the files and renames the zip to include the version-name
pack:
	@mkdir -p $(DIST_DIR)
	@echo "Packaging extension version $(VERSION_NAME)..."
	gnome-extensions pack -o $(DIST_DIR) --force --extra-source=icon.svg
	@mv $(DIST_DIR)/$(UUID).shell-extension.zip $(ZIP_FILE)
	@echo "Package created at $(ZIP_FILE)"

# 3. Bumps version, packages, commits metadata and the SPECIFIC versioned zip, tags, and pushes
release: bump
	$(eval NEW_VERSION_NAME := $(shell python3 -c "import json; print(json.load(open('metadata.json'))['version-name'])"))
	$(eval NEW_ZIP_FILE := $(DIST_DIR)/$(UUID)-v$(NEW_VERSION_NAME).shell-extension.zip)
	@$(MAKE) pack VERSION_NAME=$(NEW_VERSION_NAME) ZIP_FILE=$(NEW_ZIP_FILE)
	@echo "Staging metadata change and packaged zip file..."
	git add metadata.json $(NEW_ZIP_FILE)
	git commit -m "bump: release version $(NEW_VERSION_NAME) (includes pre-packaged zip)"
	@echo "Creating git tag v$(NEW_VERSION_NAME)..."
	git tag -a v$(NEW_VERSION_NAME) -m "Release version $(NEW_VERSION_NAME)"
	@echo "Pushing commits, zip, and tags to remote..."
	git push origin main
	git push origin v$(NEW_VERSION_NAME)

# Cleans up only uncommitted/untracked files inside the distribution directory
clean:
	@echo "Cleaning up uncommitted files in $(DIST_DIR)..."
	git clean -f $(DIST_DIR)

test:
	dbus-run-session gnome-shell --nested --wayland
