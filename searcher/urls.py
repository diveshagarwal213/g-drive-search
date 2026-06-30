from django.urls import path
from . import views

urlpatterns = [
    path('',                     views.index,             name='index'),
    path('api/stats/',           views.api_stats,         name='api_stats'),
    path('api/search/',          views.api_search,        name='api_search'),
    path('api/sync/',            views.api_sync,          name='api_sync'),
    path('api/settings/save/',   views.api_settings_save, name='api_settings_save'),
    path('api/settings/load/',   views.api_settings_load, name='api_settings_load'),
]
