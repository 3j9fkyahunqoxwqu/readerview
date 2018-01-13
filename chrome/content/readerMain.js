/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Task.jsm");

XPCOMUtils.defineLazyModuleGetter(this, "ReaderParent", "resource://readerview/ReaderParent.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "ReaderMode", "resource://readerview/ReaderMode.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "AboutReader", "resource://readerview/AboutReader.jsm");

var AboutReaderListener = {

  init() {
    setTimeout(this.checkInstall, 5);
    gBrowser.addEventListener("AboutReaderContentLoaded", this, false, true);
    gBrowser.addEventListener("DOMContentLoaded", this, false);
    gBrowser.addEventListener("pageshow", this, false);
    gBrowser.addEventListener("pagehide", this, false);
    gBrowser.addProgressListener(this.browserWindowListener);
    gBrowser.addTabsProgressListener(this.tabsProgressListener);
    window.addEventListener("aftercustomization", this.onCustomizeEnd, false);
  },

  //Adds the reader button to the urlbar on first run.
  checkInstall() {
    var first_run = Services.prefs.getBoolPref("extensions.reader.first_run");
    if (first_run == true) {
      Services.prefs.setBoolPref("extensions.reader.first_run", false);
      const afterId = "urlbar-container";
      const buttonId = "reader-mode-button";
      var prevNode = document.getElementById(afterId);
      var button = document.getElementById(buttonId);
      if (prevNode && !button) {
        var toolbar = prevNode.parentNode;
        toolbar.insertItem(buttonId, prevNode.nextSibling);
        toolbar.setAttribute("currentset", toolbar.currentSet);
        document.persist(toolbar.id, "currentset");
      }
    }
  },

  //Updates the reader button on change of the URL.
  browserWindowListener: {
    onLocationChange(aWebProgress, aRequest, aLocationURI, aFlags) {
      ReaderParent.updateReaderButton(gBrowser.selectedBrowser);
    }
  },

  //Updates the reader button on anchor navigation and history change.
  tabsProgressListener: {
    onLocationChange(aBrowser, aWebProgress, aRequest, aLocationURI,
                               aFlags) {
      // Filter out location changes caused by anchor navigation
      // or history.push/pop/replaceState.
      if (aFlags & Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT) {
        // Reader mode actually cares about these:
        var browser = gBrowser.selectedBrowser;
        this.updateReaderButton(browser, browser.isArticle);
        return;
      }
    }
  },

  //Updates the reader button after customization.
  onCustomizeEnd(event) {
    ReaderParent.updateReaderButton(gBrowser.selectedBrowser);
  },

  toggleReaderMode() {
    var browser = gBrowser.selectedBrowser;
    if (!this.isAboutReader(browser)) {
      browser._articlePromise = ReaderMode.parseDocument(browser.contentWindow.document).catch(Cu.reportError);
      ReaderMode.enterReaderMode(browser.contentWindow.document.docShell, browser.contentWindow);
    } else {
      browser._isLeavingReaderableReaderMode = this.isReaderableAboutReader(browser);
      ReaderMode.leaveReaderMode(browser.contentWindow.document.docShell, browser.contentWindow);
    }
  },

  isAboutReader(browser) {
    if (!browser.contentWindow) {
      return false;
    }
    return browser.contentWindow.document.documentURI.startsWith("about:reader");
  },

  isReaderableAboutReader(browser) {
    return this.isAboutReader(browser) &&
      !browser.contentWindow.document.documentElement.dataset.isError;
  },

  handleEvent(aEvent) {
    var browser = gBrowser.getBrowserForDocument(aEvent.target.defaultView.document);
    if (!browser) {
      return;
    }

    switch (aEvent.type) {
      case "AboutReaderContentLoaded":
        if (!this.isAboutReader(browser)) {
          return;
        }

        if (browser.contentWindow.document.body) {
          // Update the toolbar icon to show the "reader active" icon.
          ReaderParent.updateReaderButton(browser);
          new AboutReader(browser.contentWindow, browser._articlePromise);
          browser._articlePromise = null;
        }
        break;

      case "pagehide":
        this.cancelPotentialPendingReadabilityCheck(browser);
        // browser._isLeavingReaderableReaderMode is used here to keep the Reader Mode icon
        // visible in the location bar when transitioning from reader-mode page
        // back to the readable source page.
        if (browser._isLeavingReaderableReaderMode === undefined)
        {
          browser._isLeavingReaderableReaderMode = false;
        }
        browser.isArticle = browser._isLeavingReaderableReaderMode;
        ReaderParent.updateReaderButton(browser);
        if (browser._isLeavingReaderableReaderMode) {
          browser._isLeavingReaderableReaderMode = false;
        }
        break;

      case "pageshow":
        // If a page is loaded from the bfcache, we won't get a "DOMContentLoaded"
        // event, so we need to rely on "pageshow" in this case.
        if (aEvent.persisted) {
          this.updateReaderButton(browser);
        }
        break;
      case "DOMContentLoaded":
        this.updateReaderButton(browser);
        break;

    }
  },

  /**
   * NB: this function will update the state of the reader button asynchronously
   * after the next mozAfterPaint call (assuming reader mode is enabled and
   * this is a suitable document). Calling it on things which won't be
   * painted is not going to work.
   */
  updateReaderButton(browser, forceNonArticle) {
    if (!ReaderMode.isEnabledForParseOnLoad || this.isAboutReader(browser) ||
        !browser.contentWindow || !(browser.contentWindow.document instanceof browser.contentWindow.HTMLDocument) ||
        browser.contentWindow.document.mozSyntheticDocument) {
      return;
    }

    this.scheduleReadabilityCheckPostPaint(browser, forceNonArticle);
  },

  cancelPotentialPendingReadabilityCheck(browser) {
    if (browser._pendingReadabilityCheck) {
      browser.removeEventListener("MozAfterPaint", browser._pendingReadabilityCheck);
      delete browser._pendingReadabilityCheck;
    }
  },

  scheduleReadabilityCheckPostPaint(browser, forceNonArticle) {
    if (browser._pendingReadabilityCheck) {
      // We need to stop this check before we re-add one because we don't know
      // if forceNonArticle was true or false last time.
      this.cancelPotentialPendingReadabilityCheck(browser);
    }
    browser._pendingReadabilityCheck = this.onPaintWhenWaitedFor.bind(this, browser, forceNonArticle);
    browser.addEventListener("MozAfterPaint", browser._pendingReadabilityCheck);
  },

  onPaintWhenWaitedFor(browser, forceNonArticle, event) {
    // In non-e10s, we'll get called for paints other than ours, and so it's
    // possible that this page hasn't been laid out yet, in which case we
    // should wait until we get an event that does relate to our layout. We
    // determine whether any of our content got painted by checking if there
    // are any painted rects.
    if (!event.clientRects.length) {
      return;
    }

    this.cancelPotentialPendingReadabilityCheck(browser);
    // Only send updates when there are articles; there's no point updating with
    // |false| all the time.
    if (ReaderMode.isProbablyReaderable(browser.contentWindow.document)) {
      browser.isArticle = true;
    } else if (forceNonArticle) {
      browser.isArticle = false;
    }
    ReaderParent.updateReaderButton(browser);
  }
};

//Do initialization only once window has fully loaded
window.addEventListener("load", function () {
  AboutReaderListener.init();
}, false);
