package dev.mekholi.android.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.Image
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import dev.mekholi.android.BuildConfig
import dev.mekholi.android.PosViewModel
import dev.mekholi.android.R

/**
 * Login, the way the web app does it: a GoTrue password grant.
 *
 * No sign-up screen, and no email confirmation flow: a till is signed into a
 * shop that already exists, by someone the shop created. Account creation is a
 * different job on a different device (and the web app warns when the project
 * still requires a confirmation email, which this client cannot send).
 */
@Composable
fun LoginScreen(viewModel: PosViewModel) {
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }

    val configured = BuildConfig.SUPABASE_URL.isNotBlank() && BuildConfig.SUPABASE_ANON_KEY.isNotBlank()

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Image(
            painter = painterResource(R.drawable.mekholi_logo),
            contentDescription = "Mekholi logo",
            modifier = Modifier.size(96.dp),
        )
        Text("Mekholi", style = MaterialTheme.typography.headlineMedium)
        Text("Sign in to this shop's till", style = MaterialTheme.typography.bodyMedium)

        if (!configured) {
            Text(
                "Set mekholi.supabaseUrl and mekholi.supabaseAnonKey in gradle.properties — see android/README.md.",
                style = MaterialTheme.typography.bodySmall,
            )
            return@Column
        }

        OutlinedTextField(
            value = email,
            onValueChange = { email = it; error = null },
            label = { Text("Email") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Next),
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = password,
            onValueChange = { password = it; error = null },
            label = { Text("Password") },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
            modifier = Modifier.fillMaxWidth(),
        )

        (error ?: viewModel.message)?.let {
            Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
        }

        Button(
            onClick = {
                error = if (email.isBlank() || password.isBlank()) {
                    "Email and password are both required."
                } else {
                    viewModel.signIn(email.trim(), password)
                    null
                }
            },
            enabled = !viewModel.busy,
            modifier = Modifier.fillMaxWidth(),
        ) {
            if (viewModel.busy) CircularProgressIndicator(modifier = Modifier.padding(end = 8.dp))
            Text("Sign in")
        }
    }
}
