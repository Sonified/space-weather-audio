/**
 * modal-manager.js
 * Centralized modal state management with smooth transitions
 */

class ModalManager {
    constructor() {
        this.currentModal = null;
        this.overlay = document.getElementById('permanentOverlay');
        this.isTransitioning = false;
        this.queue = [];
        this.scrollPosition = 0; // Store scroll position when modal opens
        
        // Transition timing constants
        this.FADE_DURATION = 300; // Match CSS transition
        this.MODAL_SWAP_DELAY = 100; // Brief pause between modals
    }
    
    /**
     * Open a modal with proper overlay management
     * Handles sequential modals gracefully
     */
    async openModal(modalId, options = {}) {
        const { 
            keepOverlay = false,  // If true, don't fade overlay between modals
            onOpen = null,
            onClose = null 
        } = options;
        
        // Wait if currently transitioning
        while (this.isTransitioning) {
            await new Promise(resolve => setTimeout(resolve, 50));
        }

        this.isTransitioning = true;

        try {
            const modal = document.getElementById(modalId);
            if (!modal) {
                console.error(`❌ Modal not found: ${modalId}`);
                return null;
            }
            
            // If switching modals and keeping overlay visible
            if (window.pm?.interaction) console.log(`🔧 openModal: Checking if swap needed. currentModal=${this.currentModal}, keepOverlay=${keepOverlay}`);
            if (this.currentModal && this.currentModal !== '__overlay_active__' && keepOverlay) {
                if (window.pm?.interaction) console.log(`🔧 openModal: SWAPPING modal (currentModal=${this.currentModal} -> ${modalId})`);
                // Return the promise from swapModal so workflow waits for modal to close
                return await this.swapModal(modalId, { onOpen, onClose });
            } else if (this.currentModal === '__overlay_active__' && keepOverlay) {
                // Overlay is already up from a previous keepOverlay close — just show the new modal
                if (window.pm?.interaction) console.log(`🔧 openModal: OVERLAY ACTIVE, showing ${modalId} directly (no swap delay)`);
                // Show with fade transition
                modal.style.transition = '';  // Restore CSS transition
                modal.style.display = 'flex';
                modal.offsetHeight;  // Reflow so opacity transition plays
                modal.classList.add('modal-visible');
                this.currentModal = modalId;
                if (onOpen) onOpen();
                return new Promise((resolve) => {
                    modal._closeResolver = resolve;
                    modal._onClose = onClose;
                });
            } else {
                if (window.pm?.interaction) console.log(`🔧 openModal: FRESH OPEN (currentModal=${this.currentModal}, keepOverlay=${keepOverlay})`);
                // Fresh open (with overlay fade-in)
                await this.closeAllModals(false); // Don't re-enable scroll, we're about to open a modal
                
                // Disable background scrolling
                this.disableBackgroundScroll();
                
                await this.fadeInOverlay();
                modal.style.transition = '';  // Restore CSS transition for fresh opens
                modal.style.display = 'flex';
                // Trigger reflow so the opacity transition plays
                modal.offsetHeight;
                modal.classList.add('modal-visible');
                this.currentModal = modalId;
                
                if (onOpen) onOpen();

                // Return promise that resolves when modal closes
                if (window.pm?.interaction) {
                    console.log(`🔧 openModal: Creating promise for ${modalId}`);
                    console.log(`🔧 openModal: Modal element:`, modal);
                    console.log(`🔧 openModal: Current modal state:`, this.currentModal);
                }
                return new Promise((resolve) => {
                    if (window.pm?.interaction) console.log(`🔧 openModal: Setting _closeResolver for ${modalId}`);
                    modal._closeResolver = resolve;
                    modal._onClose = onClose;
                    if (window.pm?.interaction) console.log(`🔧 openModal: Resolver set! modal._closeResolver exists:`, !!modal._closeResolver);
                });
            }
            
        } finally {
            this.isTransitioning = false;
        }
    }
    
    /**
     * Close current modal
     */
    async closeModal(modalId = null, options = {}) {
        const { 
            keepOverlay = false  // If true, keep overlay for next modal
        } = options;
        
        const targetModal = modalId || this.currentModal;
        if (!targetModal) return;
        
        while (this.isTransitioning) {
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        
        this.isTransitioning = true;
        
        try {
            const modal = document.getElementById(targetModal);
            if (!modal) {
                console.error(`❌ closeModal: Modal element not found for ${targetModal}`);
                return;
            }
            
            if (window.pm?.interaction) {
                console.log(`🔧 closeModal: Modal element found:`, modal);
                console.log(`🔧 closeModal: Current modal state:`, this.currentModal);
                console.log(`🔧 closeModal: Modal ID attribute:`, modal.id);
                console.log(`🔧 closeModal: Checking _closeResolver for ${targetModal}:`, !!modal._closeResolver);
                console.log(`🔧 closeModal: Modal keys:`, Object.keys(modal).filter(k => k.startsWith('_')));
            }
            
            // Call onClose callback if exists
            if (modal._onClose) {
                modal._onClose();
            }
            
            // Resolve the waiting promise
            if (modal._closeResolver) {
                if (window.pm?.interaction) console.log(`✅ closeModal: Resolving promise for ${targetModal}`);
                modal._closeResolver(true);
                modal._closeResolver = null;
            } else {
                console.warn(`⚠️ closeModal: No _closeResolver found for ${targetModal} - promise won't resolve!`);
                console.warn(`⚠️ closeModal: This means the workflow promise won't resolve and will continue immediately`);
            }
            
            // Hide modal
            modal.style.transition = 'none';
            modal.classList.remove('modal-visible');
            modal.style.display = 'none';
            // Don't restore transition — next open will handle it

            // Fade out overlay unless keeping it for next modal
            if (!keepOverlay) {
                await this.fadeOutOverlay();
                // Re-enable background scrolling when all modals are closed
                this.enableBackgroundScroll();
            }
            
            // When keepOverlay is true, the modal is hidden but overlay stays for the next modal.
            // Set currentModal to a sentinel so openModal knows overlay is up but won't
            // try to swap/fade an already-hidden modal.
            this.currentModal = keepOverlay ? '__overlay_active__' : null;
            
        } finally {
            this.isTransitioning = false;
        }
    }
    
    /**
     * Swap one modal for another (no overlay fade)
     * Beautiful pattern for sequential workflows
     * Returns a promise that resolves when the new modal closes
     */
    async swapModal(newModalId, options = {}) {
        const { onOpen = null, onClose = null } = options;
        
        if (!this.currentModal) {
            throw new Error('No modal to swap from');
        }
        
        const oldModal = document.getElementById(this.currentModal);
        const newModal = document.getElementById(newModalId);
        
        if (!newModal) {
            console.error(`❌ New modal not found: ${newModalId}`);
            return null;
        }
        
        // Instant swap — no fade between questionnaire modals
        if (oldModal) {
            oldModal.classList.remove('modal-visible');
            oldModal.style.display = 'none';
        }

        newModal.style.transition = '';  // Restore CSS transition (may have been set to 'none' by closeModal)
        newModal.style.display = 'flex';
        newModal.offsetHeight; // reflow
        newModal.classList.add('modal-visible');
        this.currentModal = newModalId;
        
        if (onOpen) onOpen();
        
        // Return promise that resolves when modal closes
        return new Promise((resolve) => {
            newModal._closeResolver = resolve;
            newModal._onClose = onClose;
        });
    }
    
    /**
     * Fade in overlay background
     */
    async fadeInOverlay() {
        if (!this.overlay) return;

        // Skip fade if overlay is already visible
        if (this.overlay.style.display !== 'none' && parseFloat(this.overlay.style.opacity) > 0) {
            this.overlay.style.display = 'flex';
            this.overlay.style.opacity = '1';
            return;
        }

        this.overlay.style.opacity = '0';
        this.overlay.style.display = 'flex';
        
        void this.overlay.offsetHeight; // Force reflow
        
        this.overlay.style.transition = 'opacity 0.3s ease-in';
        this.overlay.style.opacity = '1';
        
        await new Promise(resolve => setTimeout(resolve, this.FADE_DURATION));
    }
    
    /**
     * Fade out overlay background
     */
    async fadeOutOverlay() {
        if (!this.overlay) return;
        
        this.overlay.style.transition = 'opacity 0.3s ease-out';
        this.overlay.style.opacity = '0';
        
        await new Promise(resolve => setTimeout(resolve, this.FADE_DURATION));
        
        if (this.overlay.style.opacity === '0') {
            this.overlay.style.display = 'none';
        }
    }
    
    /**
     * Close all modals at once
     * @param {boolean} reenableScroll - If true, re-enable background scrolling (default: true)
     */
    async closeAllModals(reenableScroll = true) {
        const allModalIds = [
            'welcomeModal',
            'participantModal',
            'preSurveyModal',
            'postSurveyModal',
            'activityLevelModal',
            'awesfModal',
            'endModal',
            'beginAnalysisModal',
            'missingStudyIdModal',
            'completeConfirmationModal',
            'aboutModal',
            'emicAboutModal'
        ];
        
        allModalIds.forEach(modalId => {
            const modal = document.getElementById(modalId);
            if (modal) {
                modal.classList.remove('modal-visible');
                modal.style.display = 'none';
            }
        });
        
        this.currentModal = null;
        // Re-enable scrolling when closing all modals (unless we're about to open a new one)
        if (reenableScroll) {
            this.enableBackgroundScroll();
        }
    }
    
    /**
     * Disable background scrolling when modal is open.
     * Skips if scroll is already locked by the user via the "Lock page scroll" checkbox.
     */
    disableBackgroundScroll() {
        const lockCb = document.getElementById('lockPageScroll');
        if (lockCb && lockCb.checked) return; // Already locked by user, don't double-lock

        // Store current scroll position
        this.scrollPosition = window.pageYOffset || document.documentElement.scrollTop;
        this._modalScrollLock = true;

        document.documentElement.style.overflow = 'hidden';
        document.body.style.overflow = 'hidden';
        document.body.style.position = 'fixed';
        document.body.style.top = `-${this.scrollPosition}px`;
        document.body.style.width = '100%';
    }

    /**
     * Re-enable background scrolling when modal closes.
     * Respects the user's "Lock page scroll" preference.
     */
    enableBackgroundScroll() {
        const lockCb = document.getElementById('lockPageScroll');
        if (lockCb && lockCb.checked) {
            this._modalScrollLock = false;
            return; // User wants scroll locked, leave it
        }
        if (!this._modalScrollLock) return; // We didn't lock it, don't unlock

        this._modalScrollLock = false;

        document.documentElement.style.overflow = '';
        document.body.style.overflow = '';
        document.body.style.position = '';
        document.body.style.top = '';
        document.body.style.width = '';

        // Restore scroll position
        window.scrollTo(0, this.scrollPosition);
    }
}

// Create singleton instance
export const modalManager = new ModalManager();

