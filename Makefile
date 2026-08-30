UUID = gnome-shell-session-timer@firebirdberlin
DIST_DIR = dist
INSTALL_DIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

.PHONY: all bump pack release clean test install compile-schemas logs

all: pack

# Get the current version-name directly from metadata.json.
# EGO (extensions.gnome.org) ignores/overwrites the integer "version" field
# on upload, so version-name is our own date-based versioning scheme instead.
VERSION_NAME = $(shell python3 -c "import json; print(json.load(open('metadata.json'))['version-name'])")
ZIP_FILE = $(DIST_DIR)/$(UUID)-v$(VERSION_NAME).shell-extension.zip

# Compile the GSettings schemas required by the extension.
compile-schemas:
	@echo "Compiling GSettings schemas..."
	glib-compile-schemas schemas/

# Follow GNOME Shell logs and show errors related to this extension.
logs:
	journalctl -f -o cat /usr/bin/gnome-shell | grep --line-buffered -i -E 'gnome-shell-session-timer|extension.js'

# Install the extension as a symbolic link to the working tree.
# This is intended for local development and keeps the installed extension
# in sync with the source tree.
install: compile-schemas
	@mkdir -p $$(dirname $(INSTALL_DIR))
	@ln -sfn $(CURDIR) $(INSTALL_DIR)
	@echo "Extension installed at $(INSTALL_DIR)"

# 1. Sets version-name to today's date (YYYY.MM.DD), or appends/increments a
#    ".N" suffix if a release has already happened today.
bump:
	@echo "Current version-name is $(VERSION_NAME)"
	@python3 bump-version.py
	@echo "Version bumped to $$(python3 -c "import json; print(json.load(open('metadata.json'))['version-name'])")"

# 2. Packages the files and renames the zip to include the version-name
pack: compile-schemas
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
	rm .*.swp

test:
	dbus-run-session gnome-shell --nested --wayland
