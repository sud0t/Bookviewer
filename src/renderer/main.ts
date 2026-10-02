import { mount } from 'svelte'
import '@fontsource-variable/figtree'
import '@fontsource-variable/literata'
import './app.css'
import App from './App.svelte'

mount(App, { target: document.getElementById('app')! })
