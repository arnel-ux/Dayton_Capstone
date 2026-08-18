// Centralized SweetAlert2 helpers so every page shares the same look & feel.
const AppAlert = {
    theme: {
        confirmButtonColor: '#4f46e5',
        cancelButtonColor: '#6b7280'
    },

    success(message, title = 'Success') {
        return Swal.fire({
            icon: 'success',
            title,
            text: message,
            confirmButtonColor: this.theme.confirmButtonColor,
            timer: 2500,
            timerProgressBar: true
        });
    },

    error(message, title = 'Error') {
        return Swal.fire({
            icon: 'error',
            title,
            text: message,
            confirmButtonColor: this.theme.confirmButtonColor
        });
    },

    info(message, title = 'Info') {
        return Swal.fire({
            icon: 'info',
            title,
            text: message,
            confirmButtonColor: this.theme.confirmButtonColor
        });
    },

    warning(message, title = 'Warning') {
        return Swal.fire({
            icon: 'warning',
            title,
            text: message,
            confirmButtonColor: this.theme.confirmButtonColor
        });
    },

    // Resolves to true only if the user confirms.
    async confirm(message, { title = 'Are you sure?', confirmText = 'Yes, proceed!', danger = true } = {}) {
        const result = await Swal.fire({
            icon: 'warning',
            title,
            text: message,
            showCancelButton: true,
            confirmButtonText: confirmText,
            cancelButtonText: 'Cancel',
            confirmButtonColor: danger ? '#dc3545' : this.theme.confirmButtonColor,
            cancelButtonColor: this.theme.cancelButtonColor,
            reverseButtons: true,
            focusCancel: true
        });
        return result.isConfirmed;
    }
};
